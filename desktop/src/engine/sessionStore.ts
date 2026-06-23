import fs from 'node:fs';
import path from 'node:path';

/**
 * SessionStore —— 会话 JSONL 持久化（深模块，纯 fs，无 Electron / LLM 依赖）。
 *
 * 每个会话一个文件：`<dir>/<id>.jsonl`
 *   - 第 1 行  {v:1, type:'meta', id, title, createdAt, model, provider?}
 *   - 其余行  {type:'msg', m:<ChatCompletionMessageParam>}
 *
 * 语义：
 *   - 消息是 agent 历史的逐字持久化（含 tool_calls / tool 结果），存**原始值**——
 *     安全过滤器只作用于出站链路，恢复重放时由 Sanitizer 重新确定性掩码（见 PRD）。
 *   - append 用 appendFileSync：进程崩溃最多丢最后一行，已落盘的行不会损坏。
 *   - load 对坏行容错（跳过并计数），坏 meta 整个会话视为不可用。
 *   - meta 更新（标题）通过重写首行实现——频率极低（标题只定一次）。
 */

export interface StoredMeta {
  id: string;
  title: string;
  createdAt: string;
  model: string;
  provider?: string;
}

export interface StoredSession {
  meta: StoredMeta;
  /** agent 的 ChatCompletionMessageParam[]，此层视为不透明 JSON。 */
  messages: unknown[];
  /** load 时跳过的损坏行数（0 = 完好）。 */
  corruptLines: number;
}

export interface SessionListItem extends StoredMeta {
  updatedAt: string;
  msgCount: number;
}

const FILE_RE = /^[A-Za-z0-9_-]+\.jsonl$/;

export class SessionStore {
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    // id 由本模块生成（newId），这里防御外部传入的路径逃逸
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`invalid session id: ${id}`);
    return path.join(this.dir, `${id}.jsonl`);
  }

  ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  newId(now: Date = new Date()): string {
    const ts = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const rand = Math.random().toString(36).slice(2, 8);
    return `${ts}_${rand}`;
  }

  create(meta: StoredMeta): void {
    this.ensureDir();
    const line = JSON.stringify({ v: 1, type: 'meta', ...meta });
    fs.writeFileSync(this.file(meta.id), line + '\n', 'utf8');
  }

  appendMessages(id: string, messages: unknown[]): void {
    if (messages.length === 0) return;
    const chunk = messages.map((m) => JSON.stringify({ type: 'msg', m })).join('\n') + '\n';
    fs.appendFileSync(this.file(id), chunk, 'utf8');
  }

  /** 重写首行 meta（其余行原样保留）。会话不存在时抛错。 */
  updateMeta(id: string, patch: Partial<Omit<StoredMeta, 'id'>>): StoredMeta {
    const loaded = this.load(id);
    if (!loaded) throw new Error(`session not found: ${id}`);
    const meta: StoredMeta = { ...loaded.meta, ...patch, id };
    const lines = [JSON.stringify({ v: 1, type: 'meta', ...meta })];
    for (const m of loaded.messages) lines.push(JSON.stringify({ type: 'msg', m }));
    const tmp = this.file(id) + '.tmp';
    fs.writeFileSync(tmp, lines.join('\n') + '\n', 'utf8');
    fs.renameSync(tmp, this.file(id));
    return meta;
  }

  load(id: string): StoredSession | null {
    const fp = this.file(id); // id 校验在 try 之外：非法 id 是调用方 bug，要炸出来
    let raw: string;
    try {
      raw = fs.readFileSync(fp, 'utf8');
    } catch {
      return null;
    }
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) return null;
    let meta: StoredMeta | null = null;
    const messages: unknown[] = [];
    let corruptLines = 0;
    for (const [i, line] of lines.entries()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        corruptLines += 1;
        continue;
      }
      const obj = parsed as Record<string, unknown>;
      if (i === 0 || obj.type === 'meta') {
        if (
          obj.type === 'meta' &&
          typeof obj.id === 'string' &&
          typeof obj.title === 'string' &&
          typeof obj.createdAt === 'string' &&
          typeof obj.model === 'string'
        ) {
          meta = {
            id: obj.id,
            title: obj.title,
            createdAt: obj.createdAt,
            model: obj.model,
            provider: typeof obj.provider === 'string' ? obj.provider : undefined,
          };
        } else if (i === 0) {
          // 首行不是合法 meta：整个文件不可信
          return null;
        }
        continue;
      }
      if (obj.type === 'msg' && 'm' in obj) messages.push(obj.m);
      else corruptLines += 1;
    }
    if (!meta) return null;
    return { meta, messages, corruptLines };
  }

  list(): SessionListItem[] {
    let files: string[];
    try {
      files = fs.readdirSync(this.dir).filter((f) => FILE_RE.test(f));
    } catch {
      return [];
    }
    const items: SessionListItem[] = [];
    for (const f of files) {
      const id = f.replace(/\.jsonl$/, '');
      const loaded = this.load(id);
      if (!loaded) continue;
      let updatedAt = loaded.meta.createdAt;
      try {
        updatedAt = fs.statSync(path.join(this.dir, f)).mtime.toISOString();
      } catch {
        /* keep createdAt */
      }
      items.push({ ...loaded.meta, updatedAt, msgCount: loaded.messages.length });
    }
    // 最近更新在前（会话列表顺序）
    items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return items;
  }

  delete(id: string): boolean {
    try {
      fs.unlinkSync(this.file(id));
      return true;
    } catch {
      return false;
    }
  }
}
