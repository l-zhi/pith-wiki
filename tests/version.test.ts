/**
 * 防回归：`pith-wiki --version` 必须等于 package.json 的 version。
 *
 * 写这个测试的动机：2026-05 release 0.2.0-beta.0 时 `bin/pith-wiki.ts` 里有一行
 * `.version('0.1.0')` 写死字面量，整个 `npm run dev` 链路看不到（开发者不会专门
 * 跑 `--version`），但 `npm pack` 给真用户后立刻露馅。后续如果有人再写死，
 * 这个测试会在 CI 红灯，省得到了发布日才发现。
 *
 * 直接调 `readPackageVersion()` 而不是 spawn 一个子进程跑 CLI：
 *   - 不需要先 build dist/
 *   - 不依赖系统 node 路径 / shim
 *   - 函数本身是确定的（fs 读 + JSON parse），cover 它就 cover 了 `--version` 行为
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readPackageVersion } from '../src/version.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
  version: string;
};

describe('readPackageVersion', () => {
  it('matches package.json version (catches hardcoded literals in bin entry)', () => {
    expect(readPackageVersion()).toBe(pkg.version);
  });

  it('package.json version is semver-shaped (not the literal "unknown")', () => {
    // 保险：万一未来 readPackageVersion 走 fallback 返回 'unknown' 但 package.json
    // 也意外写成 'unknown'，上面的 toBe 会假阳性通过。这条单独把 pkg.version 钉死成
    // x.y.z[-prerelease] 形状。
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  });

  it('bin entry does not hardcode a version literal in .version(...)', () => {
    // 三重保险：直接静态扫源码。如果未来有人 import 了 readPackageVersion 但又顺手
    // 改回 `.version('1.2.3')`，前两条 test 都不会响（函数本身仍然对）。这条会。
    const binSrc = fs.readFileSync(path.join(repoRoot, 'bin', 'pith-wiki.ts'), 'utf8');
    // 容忍 .version(<identifier or call>)，禁止 .version('literal') / .version("literal")
    expect(binSrc).not.toMatch(/\.version\(\s*['"][^'"]+['"]\s*\)/);
  });
});
