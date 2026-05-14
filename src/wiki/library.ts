import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { Entry, EntrySchema } from './types.js';

export interface LinkIndexEntry {
  forward: string[];
  backward: string[];
}

/**
 * 持久化索引文件 schema。落在 `<wikiRoot>/index.json`。
 *
 * 设计意图：冷启动免去对每条 entry 的 `readFileSync + matter.parse`，
 * 大库下省 50-100ms。新鲜度检查只看 collection 目录的 mtime（O(N collections)
 * 而不是 O(N entries)），在用户没改动的情况下能直接信任 cache。
 *
 * 不需要非常实时——`put`/`delete` 后用一个 5s 防抖 timer 异步刷盘；进程退出
 * 前没刷完也无所谓，下次启动 scanAll 会得到正确状态。
 */
const INDEX_FILE_VERSION = 1 as const;
interface IndexFileShape {
  version: typeof INDEX_FILE_VERSION;
  savedAt: string;
  /** 所有条目的完整 Entry。读回时直接重建 entryCache。 */
  entries: Entry[];
}

export interface LibraryServiceOptions {
  /** 关掉持久化（测试用 / 极少数场景）。默认 true。 */
  persist?: boolean;
  /** 调度 → 实际写入之间的延迟（ms）。默认 5000。 */
  persistDelayMs?: number;
}

export class LibraryService {
  private indexCache: Map<string, LinkIndexEntry> | null = null;
  private entryCache: Map<string, Entry> | null = null;

  private readonly persistEnabled: boolean;
  private readonly persistDelayMs: number;
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly wikiRoot: string,
    options: LibraryServiceOptions = {},
  ) {
    this.persistEnabled = options.persist ?? true;
    this.persistDelayMs = options.persistDelayMs ?? 5000;
  }

  /** wikiRoot 绝对路径。给需要计算 cache / sidecar 路径的子系统用。 */
  getWikiRoot(): string {
    return this.wikiRoot;
  }

  private collectionDir(collection: string): string {
    return path.join(this.wikiRoot, collection);
  }

  /**
   * Entry 在文件系统上的绝对路径。subpath 为空 / undefined 时落 collection 根（旧 flat 行为）。
   * subpath 内的 `/` 在写盘时按平台 path.sep 拼接，读 entry 时反过来归一化回 POSIX `/`。
   */
  private filePath(id: string, collection: string, subpath?: string): string {
    const dir = subpath
      ? path.join(this.collectionDir(collection), ...subpath.split('/'))
      : this.collectionDir(collection);
    return path.join(dir, `${id}.md`);
  }

  /** 持久化索引落地路径。文件，不会被 scanAll 当成 collection。 */
  private indexFilePath(): string {
    return path.join(this.wikiRoot, 'index.json');
  }

  invalidate(): void {
    this.indexCache = null;
    this.entryCache = null;
  }

  list(collection?: string): Entry[] {
    this.ensureIndex();
    const all = Array.from(this.entryCache!.values());
    return collection ? all.filter((e) => e.collection === collection) : all;
  }

  get(id: string, collection?: string): Entry | null {
    this.ensureIndex();
    if (collection) {
      // collection 限定查找：先用 cache 拿到该 id 的 entry（如存在），借它的 subpath
      // 拼出真实路径；不在 cache 里的 id 不可能落盘。
      const cached = this.entryCache!.get(id);
      if (!cached || cached.collection !== collection) return null;
      const file = this.filePath(id, collection, cached.subpath);
      return fs.existsSync(file) ? this.readFile(file, collection, cached.subpath) : null;
    }
    return this.entryCache!.get(id) ?? null;
  }

  put(entry: Entry): Entry {
    const validated = EntrySchema.parse(entry);
    // 旧 entry 可能在不同 subpath 下：put 之前先确保 entryCache 是新鲜的，
    // 找到 prior subpath 删除老文件，避免 subpath 变更后留下幽灵 entry。
    this.ensureIndex();
    const prior = this.entryCache!.get(validated.id);
    const file = this.filePath(validated.id, validated.collection, validated.subpath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    const { content, ...rest } = validated;
    const frontmatter = Object.fromEntries(
      Object.entries(rest).filter(([, v]) => v !== undefined),
    );
    const body = matter.stringify(content, frontmatter);
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, file);
    // 如果 entry 之前在另一个 (collection, subpath) 下，删掉那份老文件
    if (prior) {
      const priorFile = this.filePath(prior.id, prior.collection, prior.subpath);
      if (priorFile !== file && fs.existsSync(priorFile)) {
        try {
          fs.unlinkSync(priorFile);
        } catch {
          // 删不掉也不致命：cache 会指向新位置，老文件下次 scan 还会被读回造成幽灵；
          // 但日常路径下 rename 拿到的目录权限够，这里几乎不会触发
        }
      }
    }
    this.invalidate();
    this.schedulePersist();
    return validated;
  }

  delete(id: string, collection: string): boolean {
    this.ensureIndex();
    const cached = this.entryCache!.get(id);
    if (!cached || cached.collection !== collection) return false;
    const file = this.filePath(id, collection, cached.subpath);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    this.invalidate();
    this.schedulePersist();
    return true;
  }

  linkIndex(): Map<string, LinkIndexEntry> {
    this.ensureIndex();
    return this.indexCache!;
  }

  /**
   * 同步把当前 cache 立即写盘（用于 REPL 退出 / 队列 worker shutdown 等场景，
   * 把还在 5s 防抖窗口内的写入落地）。如果 cache 为空或持久化禁用 → no-op。
   */
  flushIndex(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.persistEnabled) return;
    if (!this.entryCache) return;
    try {
      this.writeIndexToDisk(Array.from(this.entryCache.values()));
    } catch {
      // best-effort：忽略写盘失败，下次启动会 scanAll 重建
    }
  }

  private ensureIndex(): void {
    if (this.indexCache && this.entryCache) return;
    let entries = this.persistEnabled ? this.readIndexFromDisk() : null;
    const fromDisk = entries !== null;
    if (!entries) entries = this.scanAll();

    const index = new Map<string, LinkIndexEntry>();
    for (const e of entries) {
      if (!index.has(e.id)) index.set(e.id, { forward: [], backward: [] });
      index.get(e.id)!.forward = [...e.links];
    }
    for (const e of entries) {
      for (const target of e.links) {
        if (!index.has(target)) index.set(target, { forward: [], backward: [] });
        index.get(target)!.backward.push(e.id);
      }
    }
    this.indexCache = index;
    this.entryCache = new Map(entries.map((e) => [e.id, e]));

    // 从 scanAll 重建（说明磁盘 cache 不在或已陈旧）→ 安排持久化，让下次启动直接命中
    if (!fromDisk) this.schedulePersist();
  }

  /**
   * 尝试从 `<wikiRoot>/index.json` 加载快照。
   *
   * 拒绝（返回 null）的情况：
   *   1. 文件不存在 / 解析失败 / version 不匹配
   *   2. 任一 collection 目录的 mtime > index.json 的 mtime
   *      （目录 mtime 在文件添加/删除时会被 bump，这就抓到了"外部新增/删除条目"）
   *
   * 注意：不会抓"在原地编辑现有 .md 内容但目录 mtime 不变"的情况。这种场景留给
   * watcher 走正常 enqueue → put 链路，或者用户手动删除 index.json 强制 rebuild。
   */
  private readIndexFromDisk(): Entry[] | null {
    const file = this.indexFilePath();
    if (!fs.existsSync(file)) return null;

    let parsed: IndexFileShape;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const obj = JSON.parse(raw);
      if (obj?.version !== INDEX_FILE_VERSION || !Array.isArray(obj.entries)) return null;
      parsed = obj as IndexFileShape;
    } catch {
      return null;
    }

    let indexMtime: number;
    try {
      indexMtime = fs.statSync(file).mtimeMs;
    } catch {
      return null;
    }

    if (fs.existsSync(this.wikiRoot)) {
      const dirs = fs
        .readdirSync(this.wikiRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'));
      for (const d of dirs) {
        try {
          const dirMtime = fs.statSync(path.join(this.wikiRoot, d.name)).mtimeMs;
          if (dirMtime > indexMtime) return null;
        } catch {
          return null;
        }
      }
    }

    // schema 兼容性兜底：用 Zod 把每条 entry 校验一遍。任何一条不合法 → 整份作废重建。
    try {
      return parsed.entries.map((e) => EntrySchema.parse(e));
    } catch {
      return null;
    }
  }

  /** 调度一次防抖刷盘。多次调用合并成一次实际写入。 */
  private schedulePersist(): void {
    if (!this.persistEnabled) return;
    if (this.persistTimer) return; // 已在窗口内，等同一次写入完成
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        if (!this.entryCache) return;
        this.writeIndexToDisk(Array.from(this.entryCache.values()));
      } catch {
        // best-effort
      }
    }, this.persistDelayMs);
    // 别让 timer 阻塞进程退出——cli 里跑完命令就该退，不该等 5s
    this.persistTimer.unref?.();
  }

  /** 原子写入：仿 put 的 .tmp + rename 模式，rename 在同 fs 上是原子的。 */
  private writeIndexToDisk(entries: Entry[]): void {
    fs.mkdirSync(this.wikiRoot, { recursive: true });
    const file = this.indexFilePath();
    const tmp = `${file}.tmp`;
    const payload: IndexFileShape = {
      version: INDEX_FILE_VERSION,
      savedAt: new Date().toISOString(),
      entries,
    };
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  private scanAll(): Entry[] {
    if (!fs.existsSync(this.wikiRoot)) return [];
    // 跳过 dotdir：兜底 .cache（converter sidecar）、可能的 .git 等。
    // entry collection 不允许以 `.` 开头，所以过滤是无损的。
    const collections = fs
      .readdirSync(this.wikiRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'));
    const out: Entry[] = [];
    for (const c of collections) {
      const collectionRoot = path.join(this.wikiRoot, c.name);
      this.scanDirRecursive(collectionRoot, collectionRoot, c.name, out);
    }
    return out;
  }

  /**
   * 递归扫一个目录，把 .md 文件读成 Entry 收集到 out。
   * subpath 由 dirAbs 相对 collectionRoot 派生（POSIX 形式），永远跳过 dotdir。
   * 异常 / 解析失败的单个文件被静默跳过，不影响其它条目（v0 容错策略沿用）。
   */
  private scanDirRecursive(
    dirAbs: string,
    collectionRoot: string,
    collection: string,
    out: Entry[],
  ): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    // 派生当前目录相对 collectionRoot 的 subpath（POSIX）
    const rel = path.relative(collectionRoot, dirAbs);
    const subpath = rel ? rel.split(path.sep).join('/') : undefined;
    for (const e of entries) {
      if (e.name.startsWith('.')) continue; // .cache / .git / .obsidian 等
      const abs = path.join(dirAbs, e.name);
      if (e.isDirectory()) {
        this.scanDirRecursive(abs, collectionRoot, collection, out);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        try {
          out.push(this.readFile(abs, collection, subpath));
        } catch {
          // Skip malformed files; v0 doesn't try to repair them.
        }
      }
    }
  }

  private readFile(file: string, collection: string, subpath?: string): Entry {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = matter(raw);
    const id = (parsed.data.id as string) ?? path.basename(file, '.md');
    const updatedRaw = parsed.data.updated;
    const updated =
      updatedRaw instanceof Date
        ? updatedRaw.toISOString()
        : (updatedRaw ?? new Date(0).toISOString());
    // frontmatter 的 subpath 优先（明确写入的总比目录派生的可信），缺省回退到目录派生
    const fmSubpath = parsed.data.subpath as string | undefined;
    const candidate = {
      id,
      collection: (parsed.data.collection as string) ?? collection,
      subpath: fmSubpath ?? subpath,
      title: (parsed.data.title as string) ?? id,
      summary: parsed.data.summary ?? '',
      tags: parsed.data.tags ?? [],
      links: parsed.data.links ?? [],
      content: parsed.content.trim(),
      source: parsed.data.source ?? { type: 'unknown' },
      updated,
      compressionRatio: parsed.data.compressionRatio,
    };
    return EntrySchema.parse(candidate);
  }
}
