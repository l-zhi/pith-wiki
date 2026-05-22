#!/usr/bin/env node
/**
 * 一次性迁移：修复 watcher collectionFromSubdir 模式下旧 sidecar 路径多嵌套一层
 * collection 名的问题。
 *
 * 旧布局（buggy）：
 *   <wikiRoot>/<collection>/.cache/<collection>/<file>.md
 *
 * 新布局（修复后）：
 *   <wikiRoot>/<collection>/.cache/<file>.md
 *
 * 做什么：
 *   - 扫描 <wikiRoot>/index.json 里所有 entry
 *   - 对每条 entry.source.cachePath 命中"双层 <collection>"模式的：
 *       1. 把文件搬到去掉一层 <collection>/ 的目标
 *       2. 改写该 entry .md 的 frontmatter（source.cachePath）+ 同步 index.json
 *   - 全部搬完后，清掉空的 <wikiRoot>/<collection>/.cache/<collection>/ 目录
 *
 * 不做的事：
 *   - 不重跑 LLM（保留所有 hydrated content）
 *   - 不动 queue state.json（job 已经 completed/dead，不影响后续 watcher）
 *   - 不重新计算 cachePath（只对命中"双层"模式的，原样 strip 一段；其它路径保持不动）
 *
 * 安全：
 *   - 默认 dry-run，打印将要做什么，不动磁盘
 *   - --apply 才真改
 *   - 每个 entry 改 frontmatter 走 .tmp + rename（仿 LibraryService.put）
 *   - 文件冲突（目标已存在）→ 跳过该条，打 warning，不覆盖
 */
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const wikiRootArg = args.find((a) => a.startsWith('--wiki-root='));
const wikiRoot = wikiRootArg
  ? wikiRootArg.slice('--wiki-root='.length)
  : path.join(process.env.HOME, '.llm-wiki', 'wiki-data');

if (!fs.existsSync(wikiRoot)) {
  console.error(`wikiRoot does not exist: ${wikiRoot}`);
  process.exit(1);
}

const indexPath = path.join(wikiRoot, 'index.json');
if (!fs.existsSync(indexPath)) {
  console.error(`index.json not found at ${indexPath} — has the library been initialized?`);
  process.exit(1);
}

const idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
if (!Array.isArray(idx.entries)) {
  console.error('index.json: entries[] missing or malformed');
  process.exit(1);
}

console.log(`wikiRoot: ${wikiRoot}`);
console.log(`mode: ${apply ? 'APPLY (will modify disk)' : 'dry-run (no changes)'}`);
console.log(`scanning ${idx.entries.length} entries...\n`);

const plan = [];
const skipped = [];

for (const entry of idx.entries) {
  const cp = entry?.source?.cachePath;
  if (!cp) continue;
  const collection = entry.collection;
  if (!collection) continue;

  const cacheRoot = path.join(wikiRoot, collection, '.cache');
  // cachePath 必须在该 collection 的 .cache 下，否则跳过（兼容未知布局）
  const rel = path.relative(cacheRoot, cp);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;

  const segs = rel.split(path.sep);
  // 命中"双层 <collection>"模式：rel 第一段 == collection 名
  if (segs.length >= 2 && segs[0] === collection) {
    const newPath = path.join(cacheRoot, ...segs.slice(1));
    plan.push({
      id: entry.id,
      collection,
      oldPath: cp,
      newPath,
      entryFile: path.join(wikiRoot, collection, `${entry.id}.md`),
    });
  }
}

if (plan.length === 0) {
  console.log('Nothing to migrate. ✓');
  process.exit(0);
}

console.log(`found ${plan.length} entries to migrate:\n`);
for (const p of plan.slice(0, 10)) {
  console.log(`  ${p.id}`);
  console.log(`    from: ${p.oldPath}`);
  console.log(`      to: ${p.newPath}`);
}
if (plan.length > 10) console.log(`  ... and ${plan.length - 10} more\n`);

if (!apply) {
  console.log('\ndry-run complete. re-run with --apply to actually migrate.');
  process.exit(0);
}

console.log('\napplying...\n');

let moved = 0;
let frontmatterPatched = 0;
const cacheRootsTouched = new Set();

for (const p of plan) {
  // 1. 搬文件
  if (!fs.existsSync(p.oldPath)) {
    skipped.push(`${p.id}: source missing (${p.oldPath})`);
    continue;
  }
  if (fs.existsSync(p.newPath)) {
    skipped.push(`${p.id}: target already exists (${p.newPath}) — leaving both files`);
    continue;
  }
  fs.mkdirSync(path.dirname(p.newPath), { recursive: true });
  fs.renameSync(p.oldPath, p.newPath);
  moved += 1;
  cacheRootsTouched.add(path.join(wikiRoot, p.collection, '.cache', p.collection));

  // 2. 改 entry .md 的 frontmatter
  if (fs.existsSync(p.entryFile)) {
    const raw = fs.readFileSync(p.entryFile, 'utf8');
    const parsed = matter(raw);
    if (parsed.data?.source?.cachePath === p.oldPath) {
      parsed.data.source.cachePath = p.newPath;
      const rebuilt = matter.stringify(parsed.content, parsed.data);
      const tmp = `${p.entryFile}.tmp`;
      fs.writeFileSync(tmp, rebuilt, 'utf8');
      fs.renameSync(tmp, p.entryFile);
      frontmatterPatched += 1;
    } else {
      skipped.push(`${p.id}: entry frontmatter cachePath did not match (already migrated?)`);
    }
  } else {
    skipped.push(`${p.id}: entry .md missing at ${p.entryFile}`);
  }

  // 3. 同步 index.json 里的 cachePath
  const e = idx.entries.find((x) => x.id === p.id);
  if (e?.source) e.source.cachePath = p.newPath;
}

// 4. 刷 index.json（仿 LibraryService.writeIndexToDisk 的原子写）
const idxTmp = `${indexPath}.tmp`;
fs.writeFileSync(idxTmp, JSON.stringify(idx, null, 2), 'utf8');
fs.renameSync(idxTmp, indexPath);

// 5. 清空空的 <collection>/.cache/<collection>/ 目录
let rmdir = 0;
for (const dir of cacheRootsTouched) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
    rmdir += 1;
  }
}

console.log(`done.`);
console.log(`  files moved:           ${moved}`);
console.log(`  frontmatter patched:   ${frontmatterPatched}`);
console.log(`  index.json updated:    yes`);
console.log(`  empty cache dirs gc'd: ${rmdir}`);
if (skipped.length > 0) {
  console.log(`\nskipped (${skipped.length}):`);
  for (const s of skipped) console.log(`  - ${s}`);
}
