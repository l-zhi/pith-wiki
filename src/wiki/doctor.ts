/**
 * `llm-wiki doctor` 的核心扫描逻辑。
 *
 * 设计原则：
 *   - **report-only**。不修改任何 entry / 文件系统状态。`--fix` 是单独的后续 issue。
 *   - **独立的文件扫描**。不复用 `LibraryService.scanAll`——那个会**静默跳过**
 *     格式有问题的文件，正好屏蔽了我们最想报的 bug。doctor 走自己的递归扫描，
 *     每个 .md 文件都尝试解析，失败也保留为一条 problem。
 *   - **结构化 + 人类双形态**。`runDoctor` 返回 `DoctorReport` 对象，CLI 层决定
 *     输出 chalk 着色文本还是 JSON。tests 直接 assert on report 对象，与展示解耦。
 *
 * 五种 check（与 issue #24 的 acceptance criteria 对齐）：
 *   1. `frontmatter`        ── YAML 解析失败 或 `EntrySchema` 校验失败
 *   2. `orphan-link`        ── `links: [foo]` 但 `foo` 在库里不存在
 *   3. `duplicate-id`       ── 同一个 id 在两个或以上 collection 出现
 *   4. `illegal-source`     ── `source.type='file'` 但 `source.value` 在沙箱外
 *   5. `dangling-concept`   ── 正文里 `[[id]]` 标注但 id 不在库 / 不在 `links` 字段
 */
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import chalk from 'chalk';
import { EntrySchema, type Entry } from './types.js';
import { resolveSafePath, SafetyError } from '../tools/safety.js';

export type DoctorSeverity = 'error' | 'warning';

export type DoctorCheck =
  | 'frontmatter'
  | 'orphan-link'
  | 'duplicate-id'
  | 'illegal-source'
  | 'dangling-concept';

export const ALL_CHECKS: readonly DoctorCheck[] = [
  'frontmatter',
  'orphan-link',
  'duplicate-id',
  'illegal-source',
  'dangling-concept',
] as const;

export interface DoctorProblem {
  severity: DoctorSeverity;
  check: DoctorCheck;
  /** Entry id when parse succeeded; absent on frontmatter failures. */
  entryId?: string;
  collection?: string;
  /** Absolute file path of the entry (or of one of the duplicated files). */
  filePath: string;
  /** One-line human-readable description. */
  message: string;
  /** Actionable hint: what to edit and how. */
  suggestion: string;
  /** Structured extras for --json consumers / programmatic processing. */
  detail?: Record<string, unknown>;
}

export interface DoctorReport {
  summary: {
    entriesScanned: number;
    problemsFound: number;
    bySeverity: Record<DoctorSeverity, number>;
    byCheck: Record<DoctorCheck, number>;
  };
  problems: DoctorProblem[];
}

export interface DoctorOptions {
  wikiRoot: string;
  /** Subset of checks to run. Default = all 5. */
  checks?: readonly DoctorCheck[];
  /**
   * Sandbox config used for the `illegal-source` check.
   * When omitted, that check is skipped (e.g. embedding contexts that don't have a workspace).
   */
  sandbox?: {
    workspaceRoot: string;
    additionalReadPaths?: string[];
  };
}

interface ScannedFile {
  filePath: string;
  collection: string;
  rawText: string;
}

interface ParsedEntry {
  filePath: string;
  collection: string;
  entry: Entry;
}

type ParseResult =
  | { kind: 'ok'; entry: Entry }
  | {
      kind: 'fail';
      message: string;
      suggestion: string;
      detail?: Record<string, unknown>;
    };

/**
 * 入口。扫 wikiRoot，跑 5 个 check，返回结构化 report。纯函数，不打印任何东西。
 */
export function runDoctor(opts: DoctorOptions): DoctorReport {
  const checks = opts.checks ?? ALL_CHECKS;
  const enabled = (c: DoctorCheck): boolean => checks.includes(c);

  const scanned = scanWiki(opts.wikiRoot);
  const problems: DoctorProblem[] = [];
  const parsed: ParsedEntry[] = [];

  // ── check 1: frontmatter validation ──────────────────────────────────
  // 必须放在最先：parse 失败的文件不会进入 parsed[]，后续 check 自然跳过它们。
  for (const sf of scanned) {
    const result = tryParseEntry(sf);
    if (result.kind === 'ok') {
      parsed.push({ filePath: sf.filePath, collection: sf.collection, entry: result.entry });
    } else if (enabled('frontmatter')) {
      problems.push({
        severity: 'error',
        check: 'frontmatter',
        collection: sf.collection,
        filePath: sf.filePath,
        message: result.message,
        suggestion: result.suggestion,
        detail: result.detail,
      });
    }
  }

  // 后续 4 个 check 共用的"id 索引"。同一 id 可能命中多个 entry——duplicate-id
  // 检测靠它，其它 check 用 .has 判存在。
  const idIndex = new Map<string, ParsedEntry[]>();
  for (const p of parsed) {
    const list = idIndex.get(p.entry.id) ?? [];
    list.push(p);
    idIndex.set(p.entry.id, list);
  }

  // ── check 2: orphan forward links ────────────────────────────────────
  if (enabled('orphan-link')) {
    for (const p of parsed) {
      for (const target of p.entry.links) {
        if (idIndex.has(target)) continue;
        problems.push({
          severity: 'warning',
          check: 'orphan-link',
          entryId: p.entry.id,
          collection: p.collection,
          filePath: p.filePath,
          message: `links: [${target}] points to a non-existent entry`,
          suggestion: `edit ${p.filePath} and either remove "${target}" from the \`links:\` field, or create an entry with id "${target}"`,
          detail: { missingTarget: target },
        });
      }
    }
  }

  // ── check 3: duplicate IDs across collections ────────────────────────
  // 同 collection 内 LibraryService.put 已经拒绝同名，所以重复必然跨 collection。
  if (enabled('duplicate-id')) {
    for (const [id, group] of idIndex) {
      if (group.length <= 1) continue;
      const collections = [...new Set(group.map((g) => g.collection))];
      if (collections.length < 2) continue; // 同 collection 内重复——理论不会出现，跳过
      // 给每个涉事文件各报一条，user 一眼看到全部 collision 位置。
      for (const dup of group) {
        problems.push({
          severity: 'error',
          check: 'duplicate-id',
          entryId: id,
          collection: dup.collection,
          filePath: dup.filePath,
          message: `id "${id}" appears in ${group.length} files across ${collections.length} collections`,
          suggestion: `rename the id in all but one of these files; lookups by id alone are currently ambiguous (other locations: ${group
            .filter((g) => g.filePath !== dup.filePath)
            .map((g) => g.filePath)
            .join(', ')})`,
          detail: {
            collisions: group.map((g) => ({ filePath: g.filePath, collection: g.collection })),
          },
        });
      }
    }
  }

  // ── check 4: illegal source paths ────────────────────────────────────
  if (enabled('illegal-source') && opts.sandbox) {
    const sandboxOpts = {
      workspaceRoot: opts.sandbox.workspaceRoot,
      wikiRoot: opts.wikiRoot,
      // doctor 只做 path 检查，不真去读文件——payload 上限随便给。
      maxPayloadBytes: Number.MAX_SAFE_INTEGER,
      readOnly: true,
      additionalReadPaths: opts.sandbox.additionalReadPaths,
    };
    for (const p of parsed) {
      if (p.entry.source.type !== 'file' || !p.entry.source.value) continue;
      try {
        resolveSafePath(p.entry.source.value, 'read', sandboxOpts);
      } catch (err) {
        if (!(err instanceof SafetyError)) throw err; // 真的 IO 异常—让它冒泡
        problems.push({
          severity: 'warning',
          check: 'illegal-source',
          entryId: p.entry.id,
          collection: p.collection,
          filePath: p.filePath,
          message: `source.value points outside the read sandbox: ${p.entry.source.value}`,
          suggestion: `either move the source into workspaceRoot / wikiRoot / additionalReadPaths, extend additionalReadPaths to include its parent dir, or rewrite source.value in ${p.filePath}`,
          detail: { sourceValue: p.entry.source.value, error: err.message },
        });
      }
    }
  }

  // ── check 5: dangling [[concept-id]] mentions ────────────────────────
  // 正则匹配 `[[id]]` 或 `[[id|display text]]` 或 `[[id#anchor]]`。
  // 不抓 `[[]]` 空 marker、`[ [foo] ]`（中间有空格）等异常形态。
  if (enabled('dangling-concept')) {
    const CONCEPT_RE = /\[\[([^\]\s|#]+)(?:[|#][^\]]*)?\]\]/g;
    for (const p of parsed) {
      const linksSet = new Set(p.entry.links);
      const seen = new Set<string>(); // 同一个 [[id]] 在正文里重复出现只报一次
      for (const m of p.entry.content.matchAll(CONCEPT_RE)) {
        const target = m[1]?.trim();
        if (!target || seen.has(target)) continue;
        seen.add(target);
        const exists = idIndex.has(target);
        const inLinks = linksSet.has(target);
        if (!exists) {
          problems.push({
            severity: 'warning',
            check: 'dangling-concept',
            entryId: p.entry.id,
            collection: p.collection,
            filePath: p.filePath,
            message: `body mentions [[${target}]] but no entry with that id exists`,
            suggestion: `either create an entry with id "${target}", delete the marker, or rewrite it to a known id`,
            detail: { target, reason: 'target-missing' },
          });
        } else if (!inLinks) {
          problems.push({
            severity: 'warning',
            check: 'dangling-concept',
            entryId: p.entry.id,
            collection: p.collection,
            filePath: p.filePath,
            message: `body mentions [[${target}]] but "${target}" is not in the \`links:\` frontmatter`,
            suggestion: `add "${target}" to the \`links:\` array in ${p.filePath} so the backlink index picks it up`,
            detail: { target, reason: 'not-in-links' },
          });
        }
      }
    }
  }

  // ── summary ──────────────────────────────────────────────────────────
  const bySeverity: Record<DoctorSeverity, number> = { error: 0, warning: 0 };
  const byCheck: Record<DoctorCheck, number> = {
    frontmatter: 0,
    'orphan-link': 0,
    'duplicate-id': 0,
    'illegal-source': 0,
    'dangling-concept': 0,
  };
  for (const p of problems) {
    bySeverity[p.severity]++;
    byCheck[p.check]++;
  }

  return {
    summary: {
      entriesScanned: parsed.length,
      problemsFound: problems.length,
      bySeverity,
      byCheck,
    },
    problems,
  };
}

/** wikiRoot 下递归收集所有 .md 文件原文。dotdir（.cache / .git 等）始终跳过。 */
function scanWiki(wikiRoot: string): ScannedFile[] {
  if (!fs.existsSync(wikiRoot)) return [];
  const collections = fs
    .readdirSync(wikiRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'));
  const out: ScannedFile[] = [];
  for (const c of collections) {
    walk(path.join(wikiRoot, c.name), c.name, out);
  }
  return out;
}

function walk(dir: string, collection: string, out: ScannedFile[]): void {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of dirents) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(abs, collection, out);
    } else if (e.isFile() && e.name.endsWith('.md')) {
      try {
        out.push({ filePath: abs, collection, rawText: fs.readFileSync(abs, 'utf8') });
      } catch {
        // unreadable file—skip silently. doctor's mandate is content quality, not disk health.
      }
    }
  }
}

/**
 * 尝试把一个 .md 文件解析成 Entry。
 *
 * 失败分两类，message 措辞要可区分：
 *   - gray-matter 抛 → YAML 语法层错误（"YAML frontmatter could not be parsed"）
 *   - matter ok 但 zod 校验失败 → schema 层错误（"frontmatter does not satisfy EntrySchema"），
 *     带出第一条 zod issue 的 path 与 message
 *
 * 不修复任何字段，但容忍 LibraryService.readFile 的几个默认：缺 id 用文件名、
 * 缺 title 用 id、缺 updated 用 epoch。这样测试能针对"用户真的没填 updated"和
 * "用户填了非法 updated"分别给出不同的 problem。
 */
function tryParseEntry(sf: ScannedFile): ParseResult {
  let fm: matter.GrayMatterFile<string>;
  try {
    fm = matter(sf.rawText);
  } catch (err) {
    return {
      kind: 'fail',
      message: `YAML frontmatter could not be parsed: ${(err as Error).message}`,
      suggestion: `open ${sf.filePath} in an editor and fix the YAML between the --- markers`,
    };
  }
  const id = (fm.data.id as string) ?? path.basename(sf.filePath, '.md');
  const updatedRaw = fm.data.updated;
  const updated =
    updatedRaw instanceof Date
      ? updatedRaw.toISOString()
      : (updatedRaw ?? new Date(0).toISOString());
  const candidate = {
    id,
    collection: (fm.data.collection as string) ?? sf.collection,
    subpath: fm.data.subpath,
    title: (fm.data.title as string) ?? id,
    summary: fm.data.summary ?? '',
    tags: fm.data.tags ?? [],
    links: fm.data.links ?? [],
    content: fm.content.trim(),
    source: fm.data.source ?? { type: 'unknown' },
    updated,
    compressionRatio: fm.data.compressionRatio,
  };
  const parsed = EntrySchema.safeParse(candidate);
  if (parsed.success) {
    return { kind: 'ok', entry: parsed.data };
  }
  const issues = parsed.error.issues;
  const firstIssue = issues[0];
  const pathStr = firstIssue?.path.join('.') || '(root)';
  return {
    kind: 'fail',
    message: `frontmatter does not satisfy EntrySchema (${issues.length} issue${
      issues.length === 1 ? '' : 's'
    }): ${firstIssue?.message ?? 'unknown'} at ${pathStr}`,
    suggestion: `fix the \`${pathStr}\` field in the YAML frontmatter of ${sf.filePath}`,
    detail: {
      issues: issues.map((i) => ({ path: i.path, message: i.message, code: i.code })),
    },
  };
}

// ── formatters ───────────────────────────────────────────────────────────

/**
 * 人类可读的终端输出（chalk 着色，非 TTY 自动降级为无色）。
 *
 * 结构：summary 行 → 按 check 分组 → 每条 problem 三行（severity+id+msg / file / fix）。
 * 排序按 ALL_CHECKS 的顺序，让 frontmatter 类硬错误总在最前面。
 */
export function formatDoctorReportHuman(report: DoctorReport): string {
  const lines: string[] = [];
  const { summary, problems } = report;

  if (summary.problemsFound === 0) {
    lines.push(chalk.green('✓ wiki is clean'));
    lines.push(chalk.gray(`  scanned ${summary.entriesScanned} entries; no problems found.`));
    return lines.join('\n');
  }

  lines.push(
    chalk.yellow(
      `⚠ found ${summary.problemsFound} problem${
        summary.problemsFound === 1 ? '' : 's'
      } across ${summary.entriesScanned} entries:`,
    ),
  );
  lines.push(
    chalk.gray(
      `  ${summary.bySeverity.error} error${
        summary.bySeverity.error === 1 ? '' : 's'
      }, ${summary.bySeverity.warning} warning${summary.bySeverity.warning === 1 ? '' : 's'}`,
    ),
  );
  lines.push('');

  const byCheck = new Map<DoctorCheck, DoctorProblem[]>();
  for (const p of problems) {
    const list = byCheck.get(p.check) ?? [];
    list.push(p);
    byCheck.set(p.check, list);
  }

  for (const check of ALL_CHECKS) {
    const group = byCheck.get(check);
    if (!group?.length) continue;
    lines.push(
      chalk.bold(`[${check}]  ${group.length} issue${group.length === 1 ? '' : 's'}`),
    );
    for (const p of group) {
      const severityTag = p.severity === 'error' ? chalk.red('error') : chalk.yellow('warn');
      const idTag = p.entryId ? chalk.cyan(p.entryId) : chalk.gray('(unparseable)');
      lines.push(`  ${severityTag}  ${idTag}  ${p.message}`);
      lines.push(`    ${chalk.gray('file:')} ${p.filePath}`);
      lines.push(`    ${chalk.gray('fix:')}  ${p.suggestion}`);
      lines.push('');
    }
  }
  return lines.join('\n').trimEnd();
}

/** JSON.stringify 兜底入口，给 `--json` flag 用。schema 见 DoctorReport / DoctorProblem。 */
export function formatDoctorReportJSON(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}
