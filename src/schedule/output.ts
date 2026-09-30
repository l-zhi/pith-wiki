import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import matter from 'gray-matter';
import { z } from 'zod';
import { LibraryService } from '../wiki/library.js';
import { EntrySchema, ID_RE, SourceSchema, SubpathSchema } from '../wiki/types.js';
import { deriveIdFromFilename } from '../wiki/idDerive.js';
import { resolveSafePath } from '../tools/safety.js';

export const ScheduledOutputContextSchema = z.object({
  taskId: z.string().regex(ID_RE),
  subpath: SubpathSchema.refine((s) => !!s && s.split('/')[0] !== 'transcripts'),
  firedAt: z.string().datetime({ offset: true }).optional(),
});
export type ScheduledOutputContext = z.infer<typeof ScheduledOutputContextSchema>;

/** write_file 与文件卡片共用同一个路径解释，兼容旧提示词中的 output/ 前缀。 */
export function scheduledOutputPath(
  outputRoot: string,
  context: ScheduledOutputContext,
  input: string,
): string {
  ScheduledOutputContextSchema.parse(context);
  const root = path.resolve(outputRoot);
  const taskRoot = path.join(root, context.subpath);
  let rel = input;
  if (path.isAbsolute(rel)) {
    const underTask = path.relative(taskRoot, rel);
    rel = isRelativeInside(underTask) ? underTask : path.relative(root, rel);
  } else {
    rel = rel.replace(/^output[/\\]/, '');
    if (rel.startsWith(context.subpath + '/')) rel = rel.slice(context.subpath.length + 1);
  }
  return path.resolve(taskRoot, rel);
}

function isRelativeInside(rel: string): boolean {
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

/** 只扫描产物文件，跳过 transcripts、隐藏目录、符号链接和临时文件。 */
function filesUnder(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith('.') || e.name === 'transcripts' || e.name.endsWith('.tmp')) return [];
    const file = path.join(root, e.name);
    return e.isDirectory() ? filesUnder(file) : e.isFile() ? [file] : [];
  });
}

export interface ArchivedOutput {
  paths: string[];
  moved: Map<string, string>;
}

/**
 * 一轮定时任务的产物归档。pith 工具和委托 CLI 共用：按任务目录接收，补齐 Markdown
 * 元数据，保留正文直接入 Wiki；只把本轮实际改动且被回复/写工具引用的旧落点搬进来。
 * 不通过 LLM 再水合，避免对已有日报二次压缩或引入额外模型调用。
 */
export class ScheduledOutputArchive {
  readonly outputRoot: string;
  readonly taskRoot: string;
  private readonly before = new Map<string, string>();
  private readonly idPaths = new Map<string, string>();

  constructor(
    private readonly library: LibraryService,
    readonly context: ScheduledOutputContext,
  ) {
    ScheduledOutputContextSchema.parse(context);
    const root = path.resolve(library.getWikiRoot(), 'output');
    this.outputRoot = resolveSafePath(root, 'write', {
      workspaceRoot: library.getWikiRoot(),
      wikiRoot: library.getWikiRoot(),
      writeRoot: root,
      readOnly: false,
      maxPayloadBytes: 0,
    });
    this.taskRoot = this.safe(path.join(this.outputRoot, context.subpath));
    for (const file of filesUnder(this.outputRoot)) this.before.set(file, fingerprint(file));
    for (const e of library.list()) {
      this.idPaths.set(
        e.id,
        path.resolve(
          fs.realpathSync(library.getWikiRoot()),
          e.collection,
          e.subpath ?? '',
          e.id + '.md',
        ),
      );
    }
  }

  finish(
    reply: string,
    writtenPaths: string[] = [],
    fallbackName = (this.context.firedAt ?? new Date().toISOString()).slice(0, 10),
  ): ArchivedOutput {
    const candidates = filesUnder(this.outputRoot).filter((file) => {
      if (this.before.get(file) === fingerprint(file)) return false;
      const own = isRelativeInside(path.relative(this.taskRoot, file));
      return (
        own ||
        writtenPaths.includes(file) ||
        reply.includes(file) ||
        reply.includes(encodeURI(file))
      );
    });
    // 没有 Markdown 产物时，保存最终答复，让仅返回文字的任务同样能被后续检索。
    if (!candidates.some((f) => path.extname(f).toLowerCase() === '.md') && reply.trim()) {
      fs.mkdirSync(this.taskRoot, { recursive: true });
      const id = deriveIdFromFilename(fallbackName) || 'result';
      const file = unusedPath(path.join(this.taskRoot, id + '.md'));
      fs.writeFileSync(file, reply, 'utf8');
      candidates.push(file);
    }
    return this.archiveFiles(candidates);
  }

  /** 也供明确归属的历史文件迁移使用；目标冲突时保留两份，不覆盖。 */
  archiveFiles(files: string[]): ArchivedOutput {
    const result: ArchivedOutput = { paths: [], moved: new Map() };
    for (const input of [...new Set(files)]) {
      const file = this.safe(input);
      if (!fs.statSync(file).isFile()) continue;
      const ownRelative = path.relative(this.taskRoot, file);
      const relative = isRelativeInside(ownRelative) ? ownRelative : path.basename(file);
      let target = this.safe(path.join(this.taskRoot, relative));
      if (file !== target) target = unusedPath(target);
      if (path.extname(file).toLowerCase() === '.md') {
        const st = fs.statSync(file);
        const parsed = matter(fs.readFileSync(file, 'utf8'));
        let id = path.basename(target, path.extname(target));
        if (!ID_RE.test(id)) id = deriveIdFromFilename(id) || 'result';
        if (
          this.idPaths.has(id) &&
          this.idPaths.get(id) !== file &&
          this.idPaths.get(id) !== target
        ) {
          const suffix = createHash('sha256').update(this.context.taskId).digest('hex').slice(0, 8);
          id = `${id}-${suffix}`;
        }
        target = this.safe(path.join(path.dirname(target), id + '.md'));
        if (target !== file) target = unusedPath(target);
        id = path.basename(target, '.md');
        const subpath = path
          .relative(this.outputRoot, path.dirname(target))
          .split(path.sep)
          .join('/');
        const old = this.idPaths.get(id) === file ? this.library.get(id) : null;
        const data = parsed.data;
        const source = SourceSchema.safeParse(data.source);
        const heading = parsed.content.match(/^#\s+(.+)$/m)?.[1];
        const strings = (v: unknown): string[] =>
          Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
        const date = id.match(/\d{4}-\d{2}-\d{2}/)?.[0];
        const entry = EntrySchema.parse({
          ...data,
          id,
          collection: 'output',
          subpath,
          scheduledTaskId: this.context.taskId,
          title: typeof data.title === 'string' && data.title ? data.title : heading || id,
          summary:
            typeof data.summary === 'string'
              ? data.summary
              : parsed.content
                  .replace(/[#*`\n]+/g, ' ')
                  .trim()
                  .slice(0, 240),
          tags: [...new Set([...strings(data.tags), 'scheduled'])],
          links: strings(data.links),
          content: parsed.content.trim(),
          source:
            source.success && source.data.type !== 'unknown'
              ? source.data
              : { type: 'file', value: target },
          updated: st.mtime.toISOString(),
          ingestedAt: old?.ingestedAt ?? st.birthtime.toISOString(),
          date: typeof data.date === 'string' ? data.date : date,
        });
        if (entry.source.type === 'file' && entry.source.value === file)
          entry.source.value = target;
        const { content, ...meta } = entry;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(
          target + '.tmp',
          matter.stringify(
            content,
            Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined)),
          ),
          'utf8',
        );
        fs.renameSync(target + '.tmp', target);
        if (file !== target) fs.unlinkSync(file);
        this.idPaths.set(id, target);
      } else if (file !== target) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(file, target);
      }
      result.paths.push(target);
      if (target !== file) result.moved.set(file, target);
    }
    // 同轮多份产物互相引用时，来源路径和正文链接也跟随归档，避免遗留失效路径。
    for (const file of result.paths.filter((f) => f.endsWith('.md'))) {
      const original = fs.readFileSync(file, 'utf8');
      let text = original;
      for (const [from, to] of result.moved)
        text = text.split(from).join(to).split(encodeURI(from)).join(encodeURI(to));
      const parsed = matter(text);
      const source = parsed.data.source as
        | { type?: string; value?: string; cachePath?: string }
        | undefined;
      if (source?.type === 'file') {
        for (const key of ['value', 'cachePath'] as const) {
          const value = source[key];
          const mapped = value && result.moved.get(path.resolve(this.library.getWikiRoot(), value));
          if (mapped) source[key] = mapped;
        }
      }
      if (
        text !== original ||
        JSON.stringify(parsed.data.source) !== JSON.stringify(matter(original).data.source)
      ) {
        fs.writeFileSync(file + '.tmp', matter.stringify(parsed.content, parsed.data), 'utf8');
        fs.renameSync(file + '.tmp', file);
      }
    }
    this.library.rebuildIndex();
    this.library.flushIndex();
    return result;
  }

  private safe(file: string): string {
    return resolveSafePath(file, 'write', {
      workspaceRoot: this.library.getWikiRoot(),
      wikiRoot: this.library.getWikiRoot(),
      writeRoot: this.outputRoot,
      readOnly: false,
      maxPayloadBytes: 0,
    });
  }
}

function fingerprint(file: string): string {
  const st = fs.statSync(file);
  return `${st.mtimeMs}:${st.size}`;
}

function unusedPath(file: string): string {
  const ext = path.extname(file);
  let candidate = file;
  for (let n = 2; fs.existsSync(candidate); n++)
    candidate = (ext ? file.slice(0, -ext.length) : file) + `-${n}` + ext;
  return candidate;
}
