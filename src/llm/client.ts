import OpenAI from 'openai';
import type { Config } from '../config.js';

export function createClient(config: Config): OpenAI {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });
}
