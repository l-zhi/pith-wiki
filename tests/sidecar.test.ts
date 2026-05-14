/**
 * converter sidecar 单元测试。
 *
 * 布局规则（贴着 entry 走，`.cache` 内部扁平）：
 *   <wikiRoot>/<collection>/<subpath?>/.cache/<basename>.md
 *
 * 关注：
 *   - cacheSidecarPath 路径推导（subpath 缺省 / 多层 subpath）
 *   - writeCacheSidecar 原子写、目录自动创建、覆盖已存在文件
 *   - 扩展名替换：.pdf → .md，无扩展名也加 .md
 *   - CJK 文件名正常落地
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cacheSidecarPath, writeCacheSidecar } from '../src/wiki/converters/sidecar.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-sidecar-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('cacheSidecarPath', () => {
  it('subpath 缺省：落 <wikiRoot>/<collection>/.cache/<basename>.md', () => {
    const out = cacheSidecarPath({
      wikiRoot: path.join(tmp, 'wiki'),
      collection: '鸡眨眼',
      absFile: '/some/where/穿越千年.pdf',
    });
    expect(out).toBe(path.join(tmp, 'wiki', '鸡眨眼', '.cache', '穿越千年.md'));
  });

  it('subpath 单层：落 <wikiRoot>/<collection>/<sub>/.cache/<basename>.md（.cache 紧贴 entry 目录）', () => {
    const out = cacheSidecarPath({
      wikiRoot: path.join(tmp, 'wiki'),
      collection: '人生大事',
      subpath: '希区柯克',
      absFile: '/src/hitchcock.pdf',
    });
    expect(out).toBe(
      path.join(tmp, 'wiki', '人生大事', '希区柯克', '.cache', 'hitchcock.md'),
    );
  });

  it('subpath 任意深度：a/b/c → 三级目录 + .cache 在最里层', () => {
    const out = cacheSidecarPath({
      wikiRoot: path.join(tmp, 'wiki'),
      collection: 'tech',
      subpath: 'a/b/c',
      absFile: '/src/foo.docx',
    });
    expect(out).toBe(path.join(tmp, 'wiki', 'tech', 'a', 'b', 'c', '.cache', 'foo.md'));
  });

  it('docx 扩展名也替换为 .md', () => {
    const out = cacheSidecarPath({
      wikiRoot: path.join(tmp, 'wiki'),
      collection: 'tech',
      absFile: '/src/a.docx',
    });
    expect(path.basename(out)).toBe('a.md');
  });

  it('无扩展名也加 .md', () => {
    const out = cacheSidecarPath({
      wikiRoot: path.join(tmp, 'wiki'),
      collection: 'tech',
      absFile: '/src/Makefile',
    });
    expect(path.basename(out)).toBe('Makefile.md');
  });

  it('subpath 内空段被过滤（防御性）', () => {
    const out = cacheSidecarPath({
      wikiRoot: path.join(tmp, 'wiki'),
      collection: 'tech',
      subpath: 'a//b',
      absFile: '/src/x.pdf',
    });
    expect(out).toBe(path.join(tmp, 'wiki', 'tech', 'a', 'b', '.cache', 'x.md'));
  });
});

describe('writeCacheSidecar', () => {
  it('原子写：目标父目录自动 mkdir，内容写入并返回绝对路径', () => {
    const out = writeCacheSidecar({
      wikiRoot: path.join(tmp, 'wiki'),
      collection: '人生大事',
      subpath: '希区柯克',
      absFile: '/src/hitchcock.pdf',
      content: '# extracted markdown\n\nbody',
    });
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.readFileSync(out, 'utf8')).toBe('# extracted markdown\n\nbody');
    expect(out).toBe(
      path.join(tmp, 'wiki', '人生大事', '希区柯克', '.cache', 'hitchcock.md'),
    );
  });

  it('已存在 sidecar 被覆盖（force re-ingest 场景）', () => {
    const wikiRoot = path.join(tmp, 'wiki');
    writeCacheSidecar({ wikiRoot, collection: 'tech', absFile: '/x.pdf', content: 'v1' });
    const out = writeCacheSidecar({
      wikiRoot,
      collection: 'tech',
      absFile: '/x.pdf',
      content: 'v2',
    });
    expect(fs.readFileSync(out, 'utf8')).toBe('v2');
  });

  it('CJK 文件名照样落地', () => {
    const out = writeCacheSidecar({
      wikiRoot: path.join(tmp, 'wiki'),
      collection: 'tech',
      absFile: '/中文报告.pdf',
      content: '中文内容',
    });
    expect(path.basename(out)).toBe('中文报告.md');
    expect(fs.readFileSync(out, 'utf8')).toBe('中文内容');
  });
});
