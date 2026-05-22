#!/usr/bin/env node
/**
 * 项目从 `llm-wiki` 改名为 `pith-wiki`（v0.3.0）后，把维护者本机 `~/.llm-wiki/`
 * 下的所有数据迁到新位置 `~/.pith-wiki/`。**一次性**脚本，跑一遍就好。
 *
 * 改了什么（按风险递增）：
 *   1. 整个目录 mv `~/.llm-wiki` → `~/.pith-wiki`
 *      包含：`.env`、`config.json`、`wiki-data/`、`queue/`、`history`、`output/`、`SOUL.md`
 *   2. `~/.pith-wiki/.env` 里 env 变量名 `LLM_WIKI_*` → `PITH_WIKI_*`
 *      （`DEEPSEEK_API_KEY` / `OPENCODE_API_KEY` 这类 provider key 不动）
 *
 * 安全：
 *   - `~/.pith-wiki/` 已存在 → 拒绝运行（避免覆盖）。手动决定怎么 merge。
 *   - `~/.llm-wiki/` 不存在 → 视为"全新装机"，no-op。
 *   - 仅做 mv + sed，不删任何东西。失败时 `~/.llm-wiki/` 仍在原位。
 *
 * 用法：
 *   node scripts/migrations/migrate-from-llm-wiki.mjs           # 干跑预览
 *   node scripts/migrations/migrate-from-llm-wiki.mjs --apply   # 真改
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const OLD_DIR = path.join(HOME, '.llm-wiki');
const NEW_DIR = path.join(HOME, '.pith-wiki');
const ENV_FILE = path.join(NEW_DIR, '.env');

const apply = process.argv.includes('--apply');

function log(line) {
  console.log(line);
}

function bail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

log(`[migrate-from-llm-wiki] mode=${apply ? 'apply' : 'dry-run'}`);
log(`  from: ${OLD_DIR}`);
log(`  to:   ${NEW_DIR}`);
log('');

if (!fs.existsSync(OLD_DIR)) {
  log('No ~/.llm-wiki/ on this machine — nothing to do. (You probably installed pith-wiki fresh.)');
  process.exit(0);
}

if (fs.existsSync(NEW_DIR)) {
  bail(
    `~/.pith-wiki/ already exists. Refusing to overwrite. ` +
      `Inspect both directories and merge manually:\n` +
      `   diff -r ${OLD_DIR} ${NEW_DIR}\n` +
      `   # decide which side wins; then either rmdir the new and re-run, or delete ~/.llm-wiki/ to skip this migration.`,
  );
}

// ── Step 1: rename the directory ─────────────────────────────────────────
if (apply) {
  fs.renameSync(OLD_DIR, NEW_DIR);
  log(`✓ moved ${OLD_DIR} → ${NEW_DIR}`);
} else {
  log(`would move ${OLD_DIR} → ${NEW_DIR}`);
}

// ── Step 2: rewrite env-var names inside .env ────────────────────────────
const envPath = apply ? ENV_FILE : path.join(OLD_DIR, '.env');
if (fs.existsSync(envPath)) {
  const original = fs.readFileSync(envPath, 'utf8');
  const updated = original.replace(/\bLLM_WIKI_/g, 'PITH_WIKI_');
  const diff = countDiff(original, updated);
  if (diff > 0) {
    if (apply) {
      // 同时备份原始 .env，万一改坏可以回滚
      fs.copyFileSync(envPath, `${envPath}.pre-rename.bak`);
      fs.writeFileSync(envPath, updated, 'utf8');
      log(`✓ rewrote ${diff} LLM_WIKI_* → PITH_WIKI_* in ${envPath}`);
      log(`  (backup: ${envPath}.pre-rename.bak)`);
    } else {
      log(`would rewrite ${diff} LLM_WIKI_* → PITH_WIKI_* in ${envPath}`);
    }
  } else {
    log(`✓ no LLM_WIKI_* references in .env — nothing to rewrite`);
  }
} else {
  log(`(no .env to update; ${envPath} doesn't exist)`);
}

log('');
if (apply) {
  log('Done. Next steps:');
  log('  1. Verify config: `pith-wiki list` (should show your old collections)');
  log('  2. Try a query:   `pith-wiki query "..."`');
  log('  3. If anything looks off, restore by `mv ~/.pith-wiki ~/.llm-wiki`.');
} else {
  log('Dry run — no changes made. Re-run with `--apply` to actually migrate.');
}

function countDiff(a, b) {
  // 数有多少行不同（粗糙但够用）
  const la = a.split('\n');
  const lb = b.split('\n');
  let n = 0;
  const len = Math.max(la.length, lb.length);
  for (let i = 0; i < len; i++) {
    if (la[i] !== lb[i]) n++;
  }
  return n;
}
