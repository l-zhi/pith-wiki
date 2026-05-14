#!/usr/bin/env node
/**
 * 一次性迁移：把 sidecar 从旧布局（collection 顶层 .cache 内嵌套子目录镜像）
 * 搬到新布局（贴着 entry 所在目录的 .cache，内部扁平）。
 *
 * 旧：<wikiRoot>/<collection>/.cache/<subpath>/<file>.md
 * 新：<wikiRoot>/<collection>/<subpath>/.cache/<file>.md
 *
 * 对每个 entry：
 *   - 计算新 cachePath = path.join(wikiRoot, collection, ...subpath segs, '.cache', basename(old))
 *   - 如果 old 存在、new 不存在 → mv
 *   - patch entry.md frontmatter 的 source.cachePath
 *   - sync index.json
 *   - GC 空的 .cache/ 目录
 *
 * 默认 dry-run，--apply 才动盘。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import matter from 'gray-matter';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const wikiRoot =
  args.find((a) => a.startsWith('--wiki-root='))?.slice('--wiki-root='.length) ??
  path.join(os.homedir(), '.llm-wiki', 'wiki-data');

if (!fs.existsSync(wikiRoot)) {
  console.error(`wikiRoot does not exist: ${wikiRoot}`);
  process.exit(1);
}
const indexPath = path.join(wikiRoot, 'index.json');
if (!fs.existsSync(indexPath)) {
  console.error(`index.json not found at ${indexPath}`);
  process.exit(1);
}

console.log(`wikiRoot: ${wikiRoot}`);
console.log(`mode:     ${apply ? 'APPLY' : 'dry-run'}\n`);

const idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
const entries = idx.entries ?? [];

/**
 * 用 .md 文件的真实 frontmatter 作为 source of truth：index.json 可能旧。
 * 递归找到 collection 下所有 <id>.md，读出 (subpath, source.cachePath)。
 */
function loadEntriesFromDisk() {
  const found = new Map(); // id → { collection, subpath, cachePath, entryFile }
  if (!fs.existsSync(wikiRoot)) return found;
  for (const cd of fs.readdirSync(wikiRoot, { withFileTypes: true })) {
    if (!cd.isDirectory() || cd.name.startsWith('.')) continue;
    const colRoot = path.join(wikiRoot, cd.name);
    walk(colRoot, colRoot, cd.name);
  }
  return found;

  function walk(dirAbs, colRoot, collection) {
    let names;
    try {
      names = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dirAbs, e.name);
      if (e.isDirectory()) walk(abs, colRoot, collection);
      else if (e.isFile() && e.name.endsWith('.md')) {
        try {
          const raw = fs.readFileSync(abs, 'utf8');
          const fm = matter(raw).data;
          const id = fm?.id;
          if (!id) continue;
          const rel = path.relative(colRoot, dirAbs);
          const subpath = fm?.subpath ?? (rel ? rel.split(path.sep).join('/') : undefined);
          const cachePath = fm?.source?.cachePath;
          found.set(id, { collection, subpath, cachePath, entryFile: abs });
        } catch {
          // skip malformed
        }
      }
    }
  }
}

const truth = loadEntriesFromDisk();
console.log(`scanned ${truth.size} entry .md files\n`);

const plan = [];
const skipped = [];

for (const [id, e] of truth) {
  if (!e.cachePath) continue;
  const basename = path.basename(e.cachePath);
  const subSegs = e.subpath ? e.subpath.split('/').filter(Boolean) : [];
  const newCp = path.join(wikiRoot, e.collection, ...subSegs, '.cache', basename);
  if (e.cachePath === newCp) continue; // already correct
  plan.push({
    id,
    collection: e.collection,
    subpath: e.subpath ?? '',
    oldCp: e.cachePath,
    newCp,
    entryFile: e.entryFile,
  });
}

if (plan.length === 0) {
  console.log('Nothing to migrate. ✓');
  process.exit(0);
}

console.log(`plan: ${plan.length} sidecars to relocate\n`);
for (const p of plan.slice(0, 8)) {
  console.log(`  ${p.id}  (${p.collection}/${p.subpath || '<root>'})`);
  console.log(`    from: ${p.oldCp}`);
  console.log(`      to: ${p.newCp}`);
}
if (plan.length > 8) console.log(`  ... and ${plan.length - 8} more`);

if (!apply) {
  console.log('\ndry-run complete. re-run with --apply to migrate.');
  process.exit(0);
}

console.log('\napplying...\n');

let moved = 0;
let patched = 0;
const touchedCacheDirs = new Set();

for (const p of plan) {
  // 1. move sidecar file
  if (fs.existsSync(p.oldCp)) {
    if (fs.existsSync(p.newCp)) {
      skipped.push(`${p.id}: target already exists at ${p.newCp}, leaving both`);
    } else {
      fs.mkdirSync(path.dirname(p.newCp), { recursive: true });
      fs.renameSync(p.oldCp, p.newCp);
      touchedCacheDirs.add(path.dirname(p.oldCp));
      moved += 1;
    }
  } else if (!fs.existsSync(p.newCp)) {
    skipped.push(`${p.id}: neither old nor new sidecar exists; leaving frontmatter untouched`);
    continue;
  }
  // 2. patch entry frontmatter
  if (fs.existsSync(p.entryFile)) {
    const raw = fs.readFileSync(p.entryFile, 'utf8');
    const parsed = matter(raw);
    if (parsed.data?.source) {
      parsed.data.source.cachePath = p.newCp;
      const tmp = `${p.entryFile}.tmp`;
      fs.writeFileSync(tmp, matter.stringify(parsed.content, parsed.data), 'utf8');
      fs.renameSync(tmp, p.entryFile);
      patched += 1;
    }
  }
  // 3. sync index.json — entry.source.cachePath 和 subpath（stale index 兜底）
  const ie = idx.entries.find((x) => x.id === p.id);
  if (ie?.source) ie.source.cachePath = p.newCp;
  if (ie && p.subpath) ie.subpath = p.subpath;
}

const idxTmp = `${indexPath}.tmp`;
fs.writeFileSync(idxTmp, JSON.stringify(idx, null, 2), 'utf8');
fs.renameSync(idxTmp, indexPath);

// GC: recursively remove empty dirs we touched (and their parents up to <collection>/.cache)
function gcEmpty(dir) {
  let removed = 0;
  if (!fs.existsSync(dir)) return 0;
  while (fs.existsSync(dir) && dir.startsWith(wikiRoot) && dir !== wikiRoot) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      break;
    }
    if (entries.length === 0) {
      try {
        fs.rmdirSync(dir);
        removed += 1;
        dir = path.dirname(dir);
      } catch {
        break;
      }
    } else {
      break;
    }
  }
  return removed;
}

// Also walk old <collection>/.cache/ trees and prune all-empty subdirs
function recursivePrune(dir) {
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    const sub = path.join(dir, name);
    if (fs.statSync(sub).isDirectory()) removed += recursivePrune(sub);
  }
  if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0 && dir !== wikiRoot) {
    try {
      fs.rmdirSync(dir);
      removed += 1;
    } catch {
      // ignore
    }
  }
  return removed;
}

let rmdirCount = 0;
for (const d of touchedCacheDirs) rmdirCount += gcEmpty(d);
// 二次扫荡：把每个 collection 顶层 .cache 内残留的空目录树清干净
for (const e of entries) {
  rmdirCount += recursivePrune(path.join(wikiRoot, e.collection, '.cache'));
}

console.log(`done.`);
console.log(`  sidecars moved:       ${moved}`);
console.log(`  frontmatter patched:  ${patched}`);
console.log(`  index.json updated:   yes`);
console.log(`  empty dirs gc'd:      ${rmdirCount}`);
if (skipped.length > 0) {
  console.log(`\nskipped (${skipped.length}):`);
  for (const s of skipped.slice(0, 20)) console.log(`  - ${s}`);
  if (skipped.length > 20) console.log(`  ... and ${skipped.length - 20} more`);
}
