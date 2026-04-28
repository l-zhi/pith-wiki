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

export interface HydrateInput {
  rawContent: string;
  source: Source;
  collectionId: string;
  autoLink?: boolean;
}

export class HydrationService {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
    private readonly library: LibraryService,
  ) {}

  async hydrate(input: HydrateInput): Promise<Entry> {
    const candidates = input.autoLink
      ? this.library
          .list(input.collectionId)
          .map((e) => `- ${e.id}: ${e.title} — ${e.summary}`)
          .join('\n')
      : '';

    const userMessage = candidates
      ? `Existing entries you may link to:\n${candidates}\n\nRaw input:\n---\n${input.rawContent}\n---`
      : `Raw input:\n---\n${input.rawContent}\n---`;

    const completion = await this.client.chat.completions.create({
      model: this.model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
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
