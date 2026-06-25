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
 * 大库下省 50-100ms。
 *
 * 新鲜度检查：保存时记下每个 collection **子树最深目录 mtime**（见
 * `collectionMtimes`），启动时只重算这一个聚合值比对。目录 mtime 在其直接子项
 * 增删/改名时变化，逐层取 max 就能捕捉子树**任意深度**的条目增删——这正是早期
 * "只看顶层 collection 目录 mtime" 的盲区：深层子目录（如
 * `工作/opensic/.../道言真经·第三部/`）新增文件只 bump 叶子目录，顶层 mtime 不动，
 * 旧索引会被当成 fresh，新条目永远进不了索引、对检索隐身。
 *
 * 仍抓不了"原地编辑现有 .md 内容但目录 mtime 不变"——这种留给 watcher 走
 * enqueue → put 链路，或用户手动删 index.json 强制 rebuild。
 *
 * 不需要非常实时——`put`/`delete` 后用一个 5s 防抖 timer 异步刷盘；进程退出
 * 前没刷完也无所谓，下次启动 scanAll 会得到正确状态。
 */
const INDEX_FILE_VERSION = 2 as const;
interface IndexFileShape {
  version: typeof INDEX_FILE_VERSION;
  savedAt: string;
  /**
   * 保存时各 collection 子树的最深目录 mtime（ms，含 collection 根目录本身）。
   * 启动时重算并逐 collection 比对：当前值 > 存档值 → 子树有增删 → 作废重建。
   * key 集合还兼做 collection 增删检测（集合不一致直接作废）。
   */
  collectionMtimes: Record<string, number>;
  /** 所有条目的完整 Entry。读回时直接重建 entryCache。 */
  entries: Entry[];
}

export interface LibraryServiceOptions {
  /** 关掉持久化（测试用 / 极少数场景）。默认 true。 */
  persist?: boolean;
  /** 调度 → 实际写入之间的延迟（ms）。默认 5000。 */
  persistDelayMs?: number;
  /**
   * 显式从扫描 / 新鲜度计算里排除的目录（绝对路径，连同其整棵子树）。
   *
   * 典型用途：raw transcripts 落在 `<wikiRoot>/output/transcripts/`，与被索引的
   * digest 条目（`<wikiRoot>/output/*.md`）共享 `output` collection 树根。scanAll
   * 是递归的，会一路扫进 transcripts 子目录——把它们当成 `output` collection 的条目
   * 灌进索引/检索是不期望的。早期靠"transcript 文件名含大写 T/Z 违反 ID_RE → 解析
   * 抛错被静默跳过"顺手挡住，但那是意外不是设计：一旦命名改动或补了合法 frontmatter
   * 就会破防。在这里显式传入 transcriptsDir 把"意外不扫"变成"有意不扫"。
   *
   * 同时也从 collectionTreeMtime 里排除——否则每回合写 transcript 都会 bump 子目录
   * mtime，反复作废 index.json cache。
   *
   * 路径在构造时统一 path.resolve 归一化；既支持顶层目录（user 把 outputDir 设成
   * `<wikiRoot>/transcripts`），也支持嵌套子目录（默认的 `output/transcripts`）。
   * 落在 wikiRoot 之外的条目是无害的 no-op（本来就不会被扫到）。
   */
  ignoredDirs?: string[];
}

export class LibraryService {
  private indexCache: Map<string, LinkIndexEntry> | null = null;
  private entryCache: Map<string, Entry> | null = null;
  /** 上次建/载索引时各 collection 子树 mtime 快照，供 refreshIfStale 运行时比对。 */
  private loadedMtimes: Record<string, number> | null = null;

  private readonly persistEnabled: boolean;
  private readonly persistDelayMs: number;
  /** 被显式忽略的目录绝对路径集合（含子树）。见 LibraryServiceOptions.ignoredDirs。 */
  private readonly ignoredDirs: Set<string>;

  private persistTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly wikiRoot: string,
    options: LibraryServiceOptions = {},
  ) {
    this.persistEnabled = options.persist ?? true;
    this.persistDelayMs = options.persistDelayMs ?? 5000;
    this.ignoredDirs = new Set((options.ignoredDirs ?? []).map((p) => path.resolve(p)));
  }

  /** 该目录（连同子树）是否被显式排除在扫描 / mtime 计算之外。 */
  private isIgnoredDir(abs: string): boolean {
    return this.ignoredDirs.size > 0 && this.ignoredDirs.has(path.resolve(abs));
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
    // ingestedAt 稳定：保留显式传入 > 既有条目的值 > 首次入库置 now。再水合不刷新它。
    const stable: Entry = {
      ...validated,
      ingestedAt: validated.ingestedAt ?? prior?.ingestedAt ?? new Date().toISOString(),
    };
    const file = this.filePath(stable.id, stable.collection, stable.subpath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    const { content, ...rest } = stable;
    const frontmatter = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
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
    return stable;
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
    // 记录此刻的 mtime 快照，作为 refreshIfStale 的运行时比对基线。
    this.loadedMtimes = this.computeCollectionMtimes();

    // 从 scanAll 重建（说明磁盘 cache 不在或已陈旧）→ 安排持久化，让下次启动直接命中
    if (!fromDisk) this.schedulePersist();
  }

  /**
   * 运行时新鲜度检查（startup 的 mtime 比对在会话中再跑一次）。
   *
   * 为什么需要：ensureIndex 一旦建好内存索引就常驻不再回看磁盘，而 write_file（agent
   * 把产物写进 <wikiRoot>/output）等**绕过 put 的直接写盘**不会让索引失效——于是新文件
   * 在重启前都不出现（曾导致「写入 output 后点开看不到新内容」）。
   *
   * 实现：比对各 collection 子树最深目录 mtime 与上次载入快照（含顶层 collection 增删）。
   * 有变化 → invalidate + 重扫，返回 true；否则只做若干次 dir stat，零文件读，返回 false。
   * 注意：和 startup 一样抓不到「原地改现有 .md 内容但目录 mtime 不变」——那仍走 watcher / put。
   */
  refreshIfStale(): boolean {
    this.ensureIndex(); // 确保有基线（首次调用时建索引）
    const current = this.computeCollectionMtimes();
    const base = this.loadedMtimes ?? {};
    const curNames = Object.keys(current);
    let changed = curNames.length !== Object.keys(base).length;
    if (!changed) {
      for (const name of curNames) {
        if (current[name] !== base[name]) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) return false;
    this.invalidate();
    this.ensureIndex(); // 重扫 + 重设 loadedMtimes
    return true;
  }

  /**
   * 尝试从 `<wikiRoot>/index.json` 加载快照。
   *
   * 拒绝（返回 null）的情况：
   *   1. 文件不存在 / 解析失败 / version 不匹配 / 缺 collectionMtimes
   *   2. collection 集合变化（顶层新增/删除 collection 目录）
   *   3. 任一 collection 的子树最深目录 mtime > 存档值
   *      （目录 mtime 在其直接子项增删/改名时 bump，逐层取 max 抓到任意深度的条目增删）
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
      if (
        obj?.version !== INDEX_FILE_VERSION ||
        !Array.isArray(obj.entries) ||
        typeof obj.collectionMtimes !== 'object' ||
        obj.collectionMtimes === null
      ) {
        return null;
      }
      parsed = obj as IndexFileShape;
    } catch {
      return null;
    }

    // 子树最深 mtime 比对：捕捉任意深度的条目增删（含顶层 collection 增删）。
    const stored = parsed.collectionMtimes;
    const current = this.computeCollectionMtimes();
    const storedNames = Object.keys(stored);
    const currentNames = Object.keys(current);
    if (storedNames.length !== currentNames.length) return null; // collection 增/删
    for (const name of currentNames) {
      if (!(name in stored)) return null; // 新 collection（同时有增有删时也能抓到）
      if (current[name] > stored[name]) return null; // 子树有增删
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
      // 写盘当下重算（在 put/delete 已落盘后，子目录 mtime 反映的是最新状态）。
      // index.json 落在 wikiRoot 根、不在任何 collection 子目录里，写它不会自我失效。
      collectionMtimes: this.computeCollectionMtimes(),
      entries,
    };
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  /**
   * 各顶层 collection → 其子树最深目录 mtime（ms）的快照。
   * 跳过 dotdir（.cache / .git / .obsidian）。wikiRoot 不存在时返回空对象。
   */
  private computeCollectionMtimes(): Record<string, number> {
    const result: Record<string, number> = {};
    if (!fs.existsSync(this.wikiRoot)) return result;
    let dirs: fs.Dirent[];
    try {
      dirs = fs.readdirSync(this.wikiRoot, { withFileTypes: true });
    } catch {
      return result;
    }
    for (const d of dirs) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue;
      const abs = path.join(this.wikiRoot, d.name);
      if (this.isIgnoredDir(abs)) continue; // 顶层就是被忽略目录（如 outputDir 设成 wikiRoot 直下）
      result[d.name] = this.collectionTreeMtime(abs);
    }
    return result;
  }

  /**
   * 一个 collection 子树里所有目录 mtime 的最大值（含 collectionRoot 本身，跳过 dotdir）。
   * 目录 mtime 在其直接子项增删/改名时变化，逐层取 max 即可捕捉子树任意深度的"条目增删"。
   * 只看目录、不 stat 文件：O(目录数) 而非 O(条目数)，保住冷启动省时的初衷。
   * 不可读的目录被静默跳过（最坏只是漏算某个分支，下次 put/启动会自愈）。
   */
  private collectionTreeMtime(collectionRoot: string): number {
    let max = 0;
    const walk = (dir: string): void => {
      let st: fs.Stats;
      try {
        st = fs.statSync(dir);
      } catch {
        return;
      }
      if (st.mtimeMs > max) max = st.mtimeMs;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        const child = path.join(dir, e.name);
        if (this.isIgnoredDir(child)) continue; // transcriptsDir 等子树：不计入 mtime，避免频繁作废 cache
        walk(child);
      }
    };
    walk(collectionRoot);
    return max;
  }

  private scanAll(): Entry[] {
    if (!fs.existsSync(this.wikiRoot)) return [];
    // 跳过 dotdir：兜底 .cache（converter sidecar）、可能的 .git 等。
    // entry collection 不允许以 `.` 开头，所以过滤是无损的。
    // 也跳过 ignoredDirs 里恰好落在顶层的目录（如 outputDir = wikiRoot 直下）。
    const collections = fs
      .readdirSync(this.wikiRoot, { withFileTypes: true })
      .filter(
        (d) =>
          d.isDirectory() &&
          !d.name.startsWith('.') &&
          !this.isIgnoredDir(path.join(this.wikiRoot, d.name)),
      );
    const out: Entry[] = [];
    for (const c of collections) {
      const collectionRoot = path.join(this.wikiRoot, c.name);
      this.scanDirRecursive(collectionRoot, collectionRoot, c.name, out);
    }
    return out;
  }

  /**
   * 递归扫一个目录，把 .md 文件读成 Entry 收集到 out。
   * subpath 由 dirAbs 相对 collectionRoot 派生（POSIX 形式），永远跳过 dotdir
   * 以及 ignoredDirs 里的目录（如 transcriptsDir 子树）。
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
        if (this.isIgnoredDir(abs)) continue; // 显式忽略：transcriptsDir 等子树不进索引
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
    // frontmatter 缺 updated 时（如 agent 用 write_file 直接写的产物）回退到文件 mtime，
    // 而非 epoch 0——否则这类条目会显示成「20629d」并永远沉到列表底部。
    const updated =
      updatedRaw instanceof Date
        ? updatedRaw.toISOString()
        : typeof updatedRaw === 'string' && updatedRaw
          ? updatedRaw
          : fs.statSync(file).mtime.toISOString();
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
      // 旧条目没有 ingestedAt → 回退到 updated（至少不为空，且对未再水合的条目就等于入库时间）
      ingestedAt: (parsed.data.ingestedAt as string) ?? updated,
      date: parsed.data.date as string | undefined,
      compressionRatio: parsed.data.compressionRatio,
    };
    return EntrySchema.parse(candidate);
  }
}
