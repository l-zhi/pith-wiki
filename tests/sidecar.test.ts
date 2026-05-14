/**
 * converter sidecar 单元测试。
 *
 * 关注：
 *   - cacheSidecarPath 路径推导（sourceRoot 镜像 / 缺省扁平 / .. 越界回退）
 *   - writeCacheSidecar 原子写、目录自动创建、覆盖已存在文件
 *   - 扩展名替换：.pdf → .md，无扩展名也加 .md
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
  it('sourceRoot 模式：镜像相对路径并替换扩展名', () => {
    const wikiRoot = path.join(tmp, 'wiki');
    const sourceRoot = path.join(tmp, 'inbox');
    const absFile = path.join(sourceRoot, 'tech/research/foo.pdf');
    const out = cacheSidecarPath({
      wikiRoot,
      collection: 'tech',
      sourceRoot,
      absFile,
    });
    expect(out).toBe(
      path.join(wikiRoot, 'tech', '.cache', 'tech/research/foo.md'),
    );
  });

  it('缺省 sourceRoot：扁平落在 .cache/<basename>.md', () => {
    const wikiRoot = path.join(tmp, 'wiki');
    const absFile = path.join(tmp, 'inbox/research/foo.pdf');
    const out = cacheSidecarPath({
      wikiRoot,
      collection: 'tech',
      absFile,
    });
    expect(out).toBe(path.join(wikiRoot, 'tech', '.cache', 'foo.md'));
  });

  it('absFile 不在 sourceRoot 之下：回退到 basename，避免逃出 .cache/', () => {
    const wikiRoot = path.join(tmp, 'wiki');
    const sourceRoot = path.join(tmp, 'inbox');
    const absFile = path.join(tmp, 'other/escape.pdf');
    const out = cacheSidecarPath({
      wikiRoot,
      collection: 'tech',
      sourceRoot,
      absFile,
    });
    expect(out).toBe(path.join(wikiRoot, 'tech', '.cache', 'escape.md'));
  });

  it('docx 扩展名也替换为 .md', () => {
    const wikiRoot = path.join(tmp, 'wiki');
    const absFile = path.join(tmp, 'inbox/a.docx');
    const out = cacheSidecarPath({
      wikiRoot,
      collection: 'tech',
      absFile,
    });
    expect(path.basename(out)).toBe('a.md');
  });

  it('无扩展名也加 .md', () => {
    const wikiRoot = path.join(tmp, 'wiki');
    const absFile = path.join(tmp, 'inbox/Makefile');
    const out = cacheSidecarPath({
      wikiRoot,
      collection: 'tech',
      absFile,
    });
    expect(path.basename(out)).toBe('Makefile.md');
  });
});

describe('writeCacheSidecar', () => {
  it('原子写：目标父目录自动 mkdir，内容写入并返回绝对路径', () => {
    const wikiRoot = path.join(tmp, 'wiki');
    const sourceRoot = path.join(tmp, 'inbox');
    const absFile = path.join(sourceRoot, 'sub/dir/report.pdf');
    const out = writeCacheSidecar({
      wikiRoot,
      collection: 'tech',
      sourceRoot,
      absFile,
      content: '# extracted markdown\n\nbody',
    });
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.readFileSync(out, 'utf8')).toBe('# extracted markdown\n\nbody');
    expect(out).toBe(
      path.join(wikiRoot, 'tech', '.cache', 'sub/dir/report.md'),
    );
  });

  it('已存在 sidecar 被覆盖（force re-ingest 场景）', () => {
    const wikiRoot = path.join(tmp, 'wiki');
    const absFile = path.join(tmp, 'inbox/x.pdf');
    writeCacheSidecar({
      wikiRoot,
      collection: 'tech',
      absFile,
      content: 'v1',
    });
    const out = writeCacheSidecar({
      wikiRoot,
      collection: 'tech',
      absFile,
      content: 'v2',
    });
    expect(fs.readFileSync(out, 'utf8')).toBe('v2');
  });

  it('CJK 文件名照样落地', () => {
    const wikiRoot = path.join(tmp, 'wiki');
    const absFile = path.join(tmp, 'inbox/中文报告.pdf');
    const out = writeCacheSidecar({
      wikiRoot,
      collection: 'tech',
      absFile,
      content: '中文内容',
    });
    expect(path.basename(out)).toBe('中文报告.md');
    expect(fs.readFileSync(out, 'utf8')).toBe('中文内容');
  });
});
