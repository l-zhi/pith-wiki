import OpenAI from 'openai';
import { Entry, HydrationOutputSchema, Source } from './types.js';
import type { LibraryService } from './library.js';

const SYSTEM_PROMPT = `You are a knowledge curator for a personal Wiki.

Compress the given raw input into ONE high-density Wiki entry. Output STRICT JSON with this exact shape:

{
  "id": "kebab-case-slug",          // unique, lowercase, hyphens only, no leading digit
  "title": "Human Readable Title",
  "summary": "One-sentence summary used for routing.",
  "tags": ["tag1", "tag2"],         // 1-6 short topical tags
  "links": ["other-entry-id"],      // entry ids you cross-reference (see candidates below); use [] if none
  "content": "# Title\\n- bullet ...\\n"  // pure Markdown body, no frontmatter
}

Rules:
- Use Markdown bullet lists. Drop fluff, transitions, marketing language.
- Keep only durable facts, definitions, and patterns. No timestamps, no first-person.
- Reference other concepts by [[concept-id]] inline; if a candidate id matches, also list it under "links".
- Aim for under ~400 words of content.`;

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
