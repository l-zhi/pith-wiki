#!/usr/bin/env node
/**
 * 一次性迁移：把现存 flat entry .md 文件按 source.value 在 watch root 下的实际位置
 * 派生 subpath，搬到 <wikiRoot>/<collection>/<subpath>/<id>.md，并同步更新 entry
 * frontmatter + index.json。sidecar 也跟着挪到 <collection>/.cache/<subpath>/...
 *
 * 例：
 *   源:   <watch>/人生大事/希区柯克/foo.pdf
 *   旧:   <wikiRoot>/人生大事/foo-id.md            (flat)
 *   新:   <wikiRoot>/人生大事/希区柯克/foo-id.md   (mirrored)
 *
 * 怎么推导 subpath：
 *   - 默认从 ~/.pith-wiki/config.json 读 watchDirs[].path
 *   - 对每个 entry：尝试每个 watch root；若 source.value 落在某个 watch root 下，
 *     用 dirname(source.value) 相对 <watch>/<collection> 算 subpath
 *   - 多个 watch root 命中：取最长前缀（最具体的）
 *
 * 默认 dry-run，--apply 才动盘。
 *
 * Usage:
 *   node scripts/migrate-entries-to-subpath.mjs                    # dry-run
 *   node scripts/migrate-entries-to-subpath.mjs --apply            # do it
 *   node scripts/migrate-entries-to-subpath.mjs --wiki-root=…      # custom wiki root
 *   node scripts/migrate-entries-to-subpath.mjs --config=…         # custom config.json
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import matter from 'gray-matter';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const wikiRoot =
  args.find((a) => a.startsWith('--wiki-root='))?.slice('--wiki-root='.length) ??
  path.join(os.homedir(), '.pith-wiki', 'wiki-data');
const configPath =
  args.find((a) => a.startsWith('--config='))?.slice('--config='.length) ??
  path.join(os.homedir(), '.pith-wiki', 'config.json');

if (!fs.existsSync(wikiRoot)) {
  console.error(`wikiRoot does not exist: ${wikiRoot}`);
  process.exit(1);
}
const indexPath = path.join(wikiRoot, 'index.json');
if (!fs.existsSync(indexPath)) {
  console.error(`index.json not found at ${indexPath}`);
  process.exit(1);
}

let watchDirs = [];
if (fs.existsSync(configPath)) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    watchDirs = Array.isArray(cfg.watchDirs) ? cfg.watchDirs : [];
  } catch (err) {
    console.warn(`failed to parse ${configPath}: ${err.message}`);
  }
}
// 展开 ~ 并规范化 path
const watchRoots = watchDirs
  .map((d) => d?.path)
  .filter(Boolean)
  .map((p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p))
  .map((p) => path.resolve(p));

if (watchRoots.length === 0) {
  console.error(
    `no watchDirs found in ${configPath}. The migration needs to know source roots ` +
      `to derive subpath. Specify --config=<path> pointing to a config.json with watchDirs.`,
  );
  process.exit(1);
}

console.log(`wikiRoot:    ${wikiRoot}`);
console.log(`watchRoots:  ${watchRoots.join(', ')}`);
console.log(`mode:        ${apply ? 'APPLY' : 'dry-run'}\n`);

const idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
const entries = idx.entries ?? [];

/**
 * 返回 absSourceFile 落在哪个 watchRoot 下；多个命中取最长前缀。null = 不在任一 watch 下。
 */
function findWatchRoot(absSourceFile) {
  let best = null;
  let bestLen = -1;
  for (const root of watchRoots) {
    const rel = path.relative(root, absSourceFile);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      if (root.length > bestLen) {
        best = root;
        bestLen = root.length;
      }
    }
  }
  return best;
}

const plan = [];
const skipped = [];

for (const e of entries) {
  if (e.subpath) {
    skipped.push(`${e.id}: already has subpath=${e.subpath}`);
    continue;
  }
  const src = e?.source?.value;
  if (!src || e.source?.type !== 'file') {
    skipped.push(`${e.id}: no source.value (type=${e.source?.type})`);
    continue;
  }
  const root = findWatchRoot(src);
  if (!root) {
    skipped.push(`${e.id}: source not under any watch root (${src})`);
    continue;
  }
  // dirname(src) 相对 <root>/<collection>
  const collectionRoot = path.join(root, e.collection);
  const rel = path.relative(collectionRoot, path.dirname(src));
  if (!rel) {
    // source 直接在 collection 根 → 不需要搬
    continue;
  }
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    skipped.push(`${e.id}: source ${src} outside <watch>/<collection> (${collectionRoot})`);
    continue;
  }
  const segs = rel.split(path.sep).filter((s) => s && !s.startsWith('.'));
  if (segs.length === 0) continue;
  const subpath = segs.join('/');

  const oldFile = path.join(wikiRoot, e.collection, `${e.id}.md`);
  const newFile = path.join(wikiRoot, e.collection, ...segs, `${e.id}.md`);
  // sidecar：旧路径 = <collection>/.cache/<basename>.md（修复后 + sidecar 已存在的）
  //          新路径 = <collection>/.cache/<sub>/<basename>.md
  const cpOld = e.source?.cachePath;
  const cpNew = cpOld
    ? path.join(
        wikiRoot,
        e.collection,
        '.cache',
        ...segs,
        path.basename(cpOld),
      )
    : undefined;

  plan.push({ id: e.id, collection: e.collection, subpath, oldFile, newFile, cpOld, cpNew });
}

if (plan.length === 0) {
  console.log('Nothing to migrate. ✓');
  if (skipped.length > 0) {
    console.log(`\nskipped (${skipped.length}):`);
    for (const s of skipped.slice(0, 10)) console.log(`  - ${s}`);
    if (skipped.length > 10) console.log(`  ... and ${skipped.length - 10} more`);
  }
  process.exit(0);
}

console.log(`plan: ${plan.length} entries\n`);
for (const p of plan.slice(0, 10)) {
  console.log(`  ${p.id} → ${p.collection}/${p.subpath}/`);
  console.log(`    entry: ${p.oldFile}`);
  console.log(`        → ${p.newFile}`);
  if (p.cpOld) {
    console.log(`    cache: ${p.cpOld}`);
    console.log(`        → ${p.cpNew}`);
  }
}
if (plan.length > 10) console.log(`  ... and ${plan.length - 10} more`);

if (!apply) {
  console.log('\ndry-run complete. re-run with --apply to migrate.');
  process.exit(0);
}

console.log('\napplying...\n');

let movedEntries = 0;
let movedCaches = 0;
let patched = 0;

for (const p of plan) {
  // 1. entry .md
  if (!fs.existsSync(p.oldFile)) {
    skipped.push(`${p.id}: entry file missing (${p.oldFile})`);
    continue;
  }
  if (fs.existsSync(p.newFile)) {
    skipped.push(`${p.id}: target entry already exists (${p.newFile})`);
    continue;
  }
  fs.mkdirSync(path.dirname(p.newFile), { recursive: true });
  fs.renameSync(p.oldFile, p.newFile);
  movedEntries += 1;

  // 2. sidecar
  if (p.cpOld && p.cpNew && fs.existsSync(p.cpOld) && !fs.existsSync(p.cpNew)) {
    fs.mkdirSync(path.dirname(p.cpNew), { recursive: true });
    fs.renameSync(p.cpOld, p.cpNew);
    movedCaches += 1;
  }

  // 3. patch frontmatter
  const raw = fs.readFileSync(p.newFile, 'utf8');
  const parsed = matter(raw);
  parsed.data.subpath = p.subpath;
  if (p.cpNew && parsed.data.source) {
    parsed.data.source.cachePath = p.cpNew;
  }
  const tmp = `${p.newFile}.tmp`;
  fs.writeFileSync(tmp, matter.stringify(parsed.content, parsed.data), 'utf8');
  fs.renameSync(tmp, p.newFile);
  patched += 1;

  // 4. sync index.json
  const ie = idx.entries.find((x) => x.id === p.id);
  if (ie) {
    ie.subpath = p.subpath;
    if (p.cpNew && ie.source) ie.source.cachePath = p.cpNew;
  }
}

// 写回 index.json
const idxTmp = `${indexPath}.tmp`;
fs.writeFileSync(idxTmp, JSON.stringify(idx, null, 2), 'utf8');
fs.renameSync(idxTmp, indexPath);

// GC：递归删空目录（限制在 wikiRoot 下，且不删 wikiRoot 本身）
function gcEmptyDirs(dir) {
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      removed += gcEmptyDirs(path.join(dir, entry.name));
    }
  }
  try {
    if (fs.readdirSync(dir).length === 0 && dir !== wikiRoot) {
      fs.rmdirSync(dir);
      removed += 1;
    }
  } catch {
    // ignore
  }
  return removed;
}
let rmdirCount = 0;
for (const e of entries) {
  rmdirCount += gcEmptyDirs(path.join(wikiRoot, e.collection, '.cache'));
  rmdirCount += gcEmptyDirs(path.join(wikiRoot, e.collection));
}

console.log(`done.`);
console.log(`  entries moved:        ${movedEntries}`);
console.log(`  sidecars moved:       ${movedCaches}`);
console.log(`  frontmatter patched:  ${patched}`);
console.log(`  index.json updated:   yes`);
console.log(`  empty dirs gc'd:      ${rmdirCount}`);
if (skipped.length > 0) {
  console.log(`\nskipped (${skipped.length}):`);
  for (const s of skipped.slice(0, 20)) console.log(`  - ${s}`);
  if (skipped.length > 20) console.log(`  ... and ${skipped.length - 20} more`);
}
