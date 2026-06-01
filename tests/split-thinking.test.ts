/**
 * splitThinking() 单元测试。
 *
 * 把一条 assistant content 拆成 { body, thinking }，覆盖：无 think、单块、多块、
 * 未闭合、带属性的开标签、大小写不敏感、纯 think（正文为空）。
 */
import { describe, expect, it } from 'vitest';
import { splitThinking } from '../src/llm/agent.js';

describe('splitThinking', () => {
  it('没有 think 标签 → 原文为 body，thinking=null', () => {
    const r = splitThinking('这是正文');
    expect(r.body).toBe('这是正文');
    expect(r.thinking).toBeNull();
  });

  it('单个成对 think 块被剥离', () => {
    const r = splitThinking('<think>我先推理一下</think>这是答案');
    expect(r.body).toBe('这是答案');
    expect(r.thinking).toBe('我先推理一下');
  });

  it('多个 think 块拼接，正文移除全部块', () => {
    const r = splitThinking('<think>步骤一</think>中段<think>步骤二</think>结论');
    expect(r.body).toBe('中段结论');
    expect(r.thinking).toBe('步骤一\n\n步骤二');
  });

  it('未闭合的 think：开标签之后全算 thinking，之前算正文', () => {
    const r = splitThinking('正文前缀<think>还没想完就被截断了');
    expect(r.body).toBe('正文前缀');
    expect(r.thinking).toBe('还没想完就被截断了');
  });

  it('大小写不敏感 + 带属性的开标签', () => {
    const r = splitThinking('<Think type="reasoning">大写且带属性</Think>答案');
    expect(r.body).toBe('答案');
    expect(r.thinking).toBe('大写且带属性');
  });

  it('纯 think（无正文）→ body 为空串', () => {
    const r = splitThinking('<think>只有思考</think>');
    expect(r.body).toBe('');
    expect(r.thinking).toBe('只有思考');
  });

  it('body 与 thinking 都做 trim', () => {
    const r = splitThinking('  <think>  想法  </think>  答案  ');
    expect(r.body).toBe('答案');
    expect(r.thinking).toBe('想法');
  });

  it('空白 think 内容视为无 thinking', () => {
    const r = splitThinking('<think>   </think>答案');
    expect(r.body).toBe('答案');
    expect(r.thinking).toBeNull();
  });
});
