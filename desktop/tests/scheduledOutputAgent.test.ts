import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, it, expect } from 'vitest';
import { LibraryService } from '../../src/wiki/library.js';
import { ScheduledOutputAgent } from '../src/engine/scheduledOutputAgent.js';
import type { AgentLike } from '../src/engine/sessionManager.js';

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'output-agent-')));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

it('delegated output is archived before final emission; persisted answer links point to the archived file', async () => {
  const history: unknown[] = [];
  const original = path.join(dir, 'output/2026-09-04.md');
  const agent: AgentLike = {
    async send(text, opts) {
      fs.mkdirSync(path.dirname(original), { recursive: true });
      fs.writeFileSync(original, '# 可检索的日报\n\n完整正文。');
      const reply = `完成：[日报](${original})`;
      history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
      opts.events?.onAssistantText?.({ text: reply, final: true });
      return reply;
    },
    exportHistory: () => history,
    restoreHistory: () => {},
  };
  const library = new LibraryService(dir, { persist: false });
  const wrapper = new ScheduledOutputAgent(agent, library, { taskId: 'daily', subpath: '日报' });
  const finals: string[] = [];
  const reply = await wrapper.send('生成日报', {
    events: {
      onAssistantText: (e) => {
        if (e.final) {
          expect(library.get('2026-09-04')?.content).toContain('完整正文');
          finals.push(e.text);
        }
      },
    },
  });
  const archived = path.join(dir, 'output/日报/2026-09-04.md');
  expect(finals).toEqual([reply]);
  expect(reply).toContain(archived);
  expect(reply).not.toContain(original);
  expect(wrapper.exportHistory().at(-1)).toMatchObject({ content: reply });
  expect(fs.existsSync(original)).toBe(false);
});
