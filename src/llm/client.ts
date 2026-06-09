import OpenAI from 'openai';
import type { Config } from '../config.js';

export function createClient(config: Config): OpenAI {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    // 显式设超时——OpenAI SDK 默认 10 分钟，对自建/兼容端点挂起时体验极差
    // （REPL 会转圈最长 10 分钟才报错）。可通过 config.requestTimeoutMs 调整。
    timeout: config.requestTimeoutMs,
  });
}
