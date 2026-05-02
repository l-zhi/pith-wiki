#!/usr/bin/env node
/**
 * 准拆包纪律：核心层不能依赖 CLI 层。
 *
 * 检查两道防线：
 *   1. 源码层：src/{wiki,llm,tools}/**、src/index.ts、src/config.ts 里
 *      禁止 import 自 src/cli/*、ink、ink-*、react、commander、chalk、dotenv。
 *   2. 产物层：dist/src/{wiki,llm,tools,index,config}.js 里禁止出现
 *      `from 'ink'`、`require('ink')` 等字面量（防止 lint 被绕过）。
 *
 * 用途：将来拆包成 @llm-wiki/core + @llm-wiki/cli 时是机械操作，无需考古。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FORBIDDEN_SOURCE_PATTERNS = [
  { kind: 'cli-relative', re: /from\s+['"]\.\.?\/cli\// },
  { kind: 'ink', re: /from\s+['"]ink(['"]|-[^'"]+['"])/ },
  { kind: 'react', re: /from\s+['"]react(['"]|-[^'"]+['"])/ },
  { kind: 'commander', re: /from\s+['"]commander['"]/ },
  { kind: 'chalk', re: /from\s+['"]chalk['"]/ },
  { kind: 'dotenv', re: /from\s+['"]dotenv['"]/, exemptFiles: ['src/config.ts'] },
];

const FORBIDDEN_DIST_PATTERNS = [
  { re: /['"]ink['"]/, exemptFiles: [] },
  { re: /['"]ink-[^'"]+['"]/, exemptFiles: [] },
  { re: /['"]react['"]/, exemptFiles: [] },
  { re: /['"]commander['"]/, exemptFiles: [] },
  { re: /['"]chalk['"]/, exemptFiles: [] },
  // dotenv：config.ts 内部只在 loadConfigFromEnv() 被调用时才执行
  // dotenv.config()，库 import 时不会触发副作用（已被 tests/no-cli-leak 校验）。
  { re: /['"]dotenv['"]/, exemptFiles: ['dist/src/config.js'] },
];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function listLibSources() {
  const dirs = ['src/wiki', 'src/llm', 'src/tools'];
  const files = [];
  for (const d of dirs) {
    const full = path.join(root, d);
    if (fs.existsSync(full)) files.push(...walk(full));
  }
  for (const f of ['src/index.ts', 'src/config.ts']) {
    const full = path.join(root, f);
    if (fs.existsSync(full)) files.push(full);
  }
  return files.filter((f) => f.endsWith('.ts'));
}

function listLibDist() {
  const dirs = ['dist/src/wiki', 'dist/src/llm', 'dist/src/tools'];
  const files = [];
  for (const d of dirs) {
    const full = path.join(root, d);
    if (fs.existsSync(full)) files.push(...walk(full));
  }
  for (const f of ['dist/src/index.js', 'dist/src/config.js']) {
    const full = path.join(root, f);
    if (fs.existsSync(full)) files.push(full);
  }
  return files.filter((f) => f.endsWith('.js'));
}

const violations = [];

for (const file of listLibSources()) {
  const rel = path.relative(root, file);
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const { kind, re, exemptFiles = [] } of FORBIDDEN_SOURCE_PATTERNS) {
      if (exemptFiles.includes(rel)) continue;
      if (re.test(lines[i])) {
        violations.push({
          source: 'src',
          file: rel,
          line: i + 1,
          kind,
          text: lines[i].trim(),
        });
      }
    }
  }
}

const distExists = fs.existsSync(path.join(root, 'dist'));
if (distExists) {
  for (const file of listLibDist()) {
    const rel = path.relative(root, file);
    const content = fs.readFileSync(file, 'utf8');
    for (const { re, exemptFiles = [] } of FORBIDDEN_DIST_PATTERNS) {
      if (exemptFiles.includes(rel)) continue;
      const match = content.match(re);
      if (match) {
        violations.push({
          source: 'dist',
          file: rel,
          line: 0,
          kind: match[0],
          text: content.split('\n').find((l) => re.test(l))?.trim() ?? '',
        });
      }
    }
  }
}

if (violations.length === 0) {
  const distNote = distExists ? '' : ' (dist 未构建，已跳过产物层检查)';
  console.log(`OK: 核心层无 CLI 依赖泄漏${distNote}`);
  process.exit(0);
}

console.error(`FAIL: 核心层依赖了 CLI/UI 层 (${violations.length} 处)：\n`);
for (const v of violations) {
  const loc = v.line ? `:${v.line}` : '';
  console.error(`  [${v.source}] ${v.file}${loc}  → ${v.kind}`);
  console.error(`    ${v.text}\n`);
}
console.error('修复：把这些 import 移到 src/cli/ 下，或抽出纯逻辑到核心层。');
process.exit(1);
