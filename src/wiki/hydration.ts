import OpenAI from 'openai';
import { Entry, HydrationOutputSchema, Source } from './types.js';
import type { LibraryService } from './library.js';

/**
 * Hydration system prompt.
 *
 * 任何修改都应被 tests/hydration-prompt.test.ts 锁定 ——
 * 那里断言了几条不可回退的硬约束（语言保持、字数上限）。
 */
export const SYSTEM_PROMPT = `You are a knowledge curator for a personal Wiki. Your job is to produce ONE high-density Wiki entry from raw input.

Output STRICT JSON in exactly this shape (no commentary, no code fences):

{
  "id": "kebab-case-slug",          // unique, lowercase ASCII a-z 0-9 and hyphens only, no leading hyphen
  "title": "Human Readable Title",
  "summary": "One-sentence routing summary.",
  "tags": ["tag1", "tag2"],         // 1-6 short topical tags
  "links": ["other-entry-id"],      // entry ids you cross-reference; use [] if none
  "content": "# Title\\n- bullet ..."   // pure Markdown body, no frontmatter
}

Hard rules — violating any of these is a failure:

1. LANGUAGE: Write \`title\`, \`summary\`, and \`content\` in the SAME PRIMARY LANGUAGE as the raw input. Chinese in → Chinese out. English in → English out. Do NOT translate. (Tags and ids must stay lowercase ASCII / kebab-case regardless of input language.)

2. WORD LIMIT: \`content\` MUST be under 400 words (or ~600 Chinese characters for CJK content). If the source is longer, drop examples, code excerpts, project history, marketing language, and second-order details. Keep only definitions, patterns, constraints, and core facts.

3. COMPRESSION: For verbose sources (articles, transcripts), aim for compression ratio ≤ 0.3 (output ≤ 30% of input length). For already-dense sources (READMEs, bullet notes), ≤ 0.5 is acceptable but never copy verbatim — always re-condense.

4. STRUCTURE: Use Markdown bullet lists. Drop transitions ("In this section..."), marketing language, first-person voice, timestamps, and self-references like "the document says".

5. CROSS-REFS: Inline references use [[concept-id]] format. If a candidate id from the link table matches, also list it under \`links\`.`;

/**
 * Conversation digest 专用 system prompt。
 *
 * 与 SYSTEM_PROMPT 的关键区别：输入是 user/assistant 多轮对话，**用户的提问
 * 本身承载语义**——揭示了用户关心什么角度、做什么对比、问的是哪个面向。
 * 直接套用文档脱水的 prompt 会把对话当成单边材料压缩，丢掉问题视角，导致
 * 例如"成长和低谷期"被压成笼统的"成长经历"。
 *
 * 任何修改都应被 tests/hydration-prompt.test.ts 锁定关键不变量。
 */
export const CONVERSATION_SYSTEM_PROMPT = `You are a knowledge curator turning a Q&A conversation into ONE high-density Wiki entry.

The raw input is a markdown-formatted conversation with sections labeled \`## User\` and \`## Assistant\` (and possibly \`### Tool: <name>\` for tool calls the assistant made). Both sides matter:

- The **user's questions** reveal *what they wanted to know*, *which angles they cared about*, and the *specific framing* that must be preserved.
- The **assistant's answers** carry the substantive claims, examples, and conclusions.

Your job is NOT to summarize only the assistant's answers. You must preserve the question's specificity in the title, summary, and structure. If the user asked about "成长和低谷期", the title must mention BOTH (e.g. "成长与低谷期反思"), NOT collapse to a generic "成长经历".

Output STRICT JSON in exactly this shape (no commentary, no code fences):

{
  "id": "kebab-case-slug",          // unique, lowercase ASCII a-z 0-9 and hyphens only, no leading hyphen
  "title": "Human Readable Title that PRESERVES the question's specificity",
  "summary": "One sentence covering BOTH what was asked AND the key takeaway.",
  "tags": ["tag1", "tag2"],         // 3-6 tags: include both the user's angle AND the answer's domain
  "links": ["other-entry-id"],      // entry ids cross-referenced; use [] if none
  "content": "# Title\\n\\n## Q: ...\\n- ...\\n\\n## Q: ...\\n- ..."
}

Hard rules — violating any of these is a failure:

1. PRESERVE THE QUESTION. The title and summary MUST reflect what the user asked, not just what was answered. If the user probed multiple angles (e.g. "X 和 Y" / "X versus Y" / "对比 X 与 Y"), all those angles MUST appear in the title — do not collapse them.

2. STRUCTURE: Use Q/A sections in the original conversational order. Each meaningful user turn becomes one section:

   ## Q: <user's question, condensed but keeping the specific framing>
   - <distilled answer points, bullet form>
   - <key claim, concrete example only if essential>

   Multiple turns → multiple sections, in order. Do NOT merge unrelated turns into one section.

3. LANGUAGE: Write \`title\`, \`summary\`, and \`content\` in the SAME PRIMARY LANGUAGE as the conversation. Chinese in → Chinese out. English in → English out. Do NOT translate. (Tags and ids stay lowercase ASCII / kebab-case regardless.)

4. WORD LIMIT: \`content\` MUST be under 400 words (or ~600 Chinese characters for CJK). Drop pleasantries, repetitions, verbose marketing-style assistant text, and second-order asides. Keep the user's specific framing, the answer's key claims, and concrete examples only when essential.

5. TAGS: 3-6 kebab-case tags. Include BOTH the topic the user probed (their angle of inquiry) AND the answer's domain. E.g. for a user asking about retry policy from a reliability angle, both \`retry\` and \`reliability\` belong in tags.

6. CROSS-REFS: Inline references use [[concept-id]] format. If a candidate id from the link table matches a concept actually discussed, also list it under \`links\`.

7. NEUTRALITY: Drop transitions ("In this section..."), marketing language, the assistant's first-person voice ("I think…" → declarative claim), timestamps, and self-references. The user's question can be paraphrased into a neutral noun phrase ("Q: <topic>"), not a verbatim quote.`;

export interface HydrateInput {
  rawContent: string;
  source: Source;
  collectionId: string;
  autoLink?: boolean;
  /**
   * 批量场景下由编排器一次性 snapshot 后注入，避免每文件 list() 触发链接索引颠簸。
   * 当此项存在时，hydrator 不再调 library.list；候选直接来自这里。
   */
  linkCandidates?: Entry[];
  /**
   * 源文件名（不含路径），作为提示词里的辅助信号——LLM 看到 filename 倾向于
   * 产出与之相关的 slug，可以降低批量入库时多个文件被分配同一个 id 的概率。
   */
  filenameHint?: string;
  /**
   * 输入材料的形态：
   *   - 'document'（默认）：单边材料（文章 / README / 笔记），用 SYSTEM_PROMPT 压缩
   *   - 'conversation'：user/assistant 多轮对话，用 CONVERSATION_SYSTEM_PROMPT，
   *     强制保留问题视角（避免"成长与低谷期"被压成"成长经历"这种丢角度问题）
   */
  mode?: 'document' | 'conversation';
}

export class HydrationService {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
    private readonly library: LibraryService,
  ) {}

  async hydrate(input: HydrateInput): Promise<Entry> {
    // 候选链接来源优先级：
    //   1. 显式注入的 linkCandidates（批量场景）
    //   2. autoLink=true 时通过 library.list 实时取（单文件场景）
    //   3. 都没有 → 空字符串（不注入候选）
    const candidateEntries: Entry[] | null = input.linkCandidates
      ? input.linkCandidates
      : input.autoLink
        ? this.library.list(input.collectionId)
        : null;
    const candidates = candidateEntries
      ? candidateEntries.map((e) => `- ${e.id}: ${e.title} — ${e.summary}`).join('\n')
      : '';

    const filenameLine = input.filenameHint ? `Filename: ${input.filenameHint}\n\n` : '';
    const userMessage = candidates
      ? `${filenameLine}Existing entries you may link to:\n${candidates}\n\nRaw input:\n---\n${input.rawContent}\n---`
      : `${filenameLine}Raw input:\n---\n${input.rawContent}\n---`;

    const systemPrompt =
      input.mode === 'conversation' ? CONVERSATION_SYSTEM_PROMPT : SYSTEM_PROMPT;
    const completion = await this.client.chat.completions.create({
      model: this.model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    });

    const text = completion.choices[0]?.message?.content;
    if (!text) throw new Error('Hydration LLM returned no content');

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`Hydration output was not valid JSON: ${(err as Error).message}`);
    }

    const out = HydrationOutputSchema.parse(parsed);
    const compressionRatio =
      input.rawContent.length > 0
        ? Math.min(1, out.content.length / input.rawContent.length)
        : undefined;

    return {
      id: out.id,
      collection: input.collectionId,
      title: out.title,
      summary: out.summary,
      tags: out.tags,
      links: out.links,
      content: out.content,
      source: input.source,
      updated: new Date().toISOString(),
      compressionRatio,
    };
  }
}
