import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { Entry, EntrySchema } from './types.js';

export interface LinkIndexEntry {
  forward: string[];
  backward: string[];
}

export class LibraryService {
  private indexCache: Map<string, LinkIndexEntry> | null = null;
  private entryCache: Map<string, Entry> | null = null;

  constructor(private readonly wikiRoot: string) {}

  private collectionDir(collection: string): string {
    return path.join(this.wikiRoot, collection);
  }

  private filePath(id: string, collection: string): string {
    return path.join(this.collectionDir(collection), `${id}.md`);
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
      const file = this.filePath(id, collection);
      return fs.existsSync(file) ? this.readFile(file, collection) : null;
    }
    return this.entryCache!.get(id) ?? null;
  }

  put(entry: Entry): Entry {
    const validated = EntrySchema.parse(entry);
    fs.mkdirSync(this.collectionDir(validated.collection), { recursive: true });
    const file = this.filePath(validated.id, validated.collection);
    const tmp = `${file}.tmp`;
    const { content, ...rest } = validated;
    const frontmatter = Object.fromEntries(
      Object.entries(rest).filter(([, v]) => v !== undefined),
    );
    const body = matter.stringify(content, frontmatter);
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, file);
    this.invalidate();
    return validated;
  }

  delete(id: string, collection: string): boolean {
    const file = this.filePath(id, collection);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    this.invalidate();
    return true;
  }

  linkIndex(): Map<string, LinkIndexEntry> {
    this.ensureIndex();
    return this.indexCache!;
  }

  private ensureIndex(): void {
    if (this.indexCache && this.entryCache) return;
    const entries = this.scanAll();
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
  }

  private scanAll(): Entry[] {
    if (!fs.existsSync(this.wikiRoot)) return [];
    const collections = fs
      .readdirSync(this.wikiRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory());
    const out: Entry[] = [];
    for (const c of collections) {
      const dir = path.join(this.wikiRoot, c.name);
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
      for (const f of files) {
        try {
          out.push(this.readFile(path.join(dir, f), c.name));
        } catch {
          // Skip malformed files; v0 doesn't try to repair them.
        }
      }
    }
    return out;
  }

  private readFile(file: string, collection: string): Entry {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = matter(raw);
    const id = (parsed.data.id as string) ?? path.basename(file, '.md');
    const updatedRaw = parsed.data.updated;
    const updated =
      updatedRaw instanceof Date
        ? updatedRaw.toISOString()
        : (updatedRaw ?? new Date(0).toISOString());
    const candidate = {
      id,
      collection: (parsed.data.collection as string) ?? collection,
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
