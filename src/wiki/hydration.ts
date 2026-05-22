import OpenAI from 'openai';
import { z } from 'zod';
import { Entry, HydrationOutputSchema, Source } from './types.js';
import type { LibraryService } from './library.js';
import { topNByQuery } from './scoring.js';
import { deriveIdFromFilename } from './idDerive.js';

/**
 * 候选链接预筛的 top-N。原本是把当前 collection 全集喂给 LLM，几百个 entry 就
 * 把 prompt 撑到几万 token——既贵又噪声大。这里按"和当前原文的关键词重合度"
 * 挑 top-N，剩下的不喂。N 取 12 是经验值：足够覆盖一篇文章常见的相关概念，
 * 同时控制 token 在几 K 内。
 */
const TOP_N_LINK_CANDIDATES = 12;

/**
 * 触发"先 plan 再 write"两遍生成的字符阈值。
 * - 短材料（< 3000 字符）：单次 LLM call，沿用旧路径；plan 没有收益反而翻倍成本
 * - 长材料：先让 LLM 出 outline + 目标长度，再按 outline 写正文；避免长文丢主线
 *
 * 3000 字符 ≈ 600-1000 字中文 / 500 词英文，正好覆盖"一篇文章/长帖"以上的体量。
 */
const LONG_DOC_THRESHOLD_CHARS = 3000;

/**
 * scoring 用的 query 文本截断长度。原文动辄几万字符全部喂给 tokenizer 浪费 CPU；
 * 前 4k 字符的关键词分布足够代表全篇主题，scoring O(n·k) 的常数能压下来。
 */
const SCORING_PROBE_CHARS = 4000;

/**
 * Hydration system prompt.
 *
 * 任何修改都应被 tests/hydration-prompt.test.ts 锁定 ——
 * 那里断言了几条不可回退的硬约束（语言保持、字数上限）。
 */
export const SYSTEM_PROMPT = `You are a knowledge curator for a personal Wiki. Your job is to produce ONE high-density Wiki entry from raw input.

Output STRICT JSON in exactly this shape (no commentary, no code fences):

{
  "id": "entry-id",                 // unique slug; see ID rule below
  "title": "Human Readable Title",
  "summary": "One-sentence routing summary.",
  "tags": ["tag1", "tag2"],         // 1-6 short topical tags
  "links": ["other-entry-id"],      // entry ids you cross-reference; use [] if none
  "content": "# Title\\n- bullet ..."   // pure Markdown body, no frontmatter
}

Hard rules — violating any of these is a failure:

1. LANGUAGE: Write \`title\`, \`summary\`, and \`content\` in the SAME PRIMARY LANGUAGE as the raw input. Chinese in → Chinese out. English in → English out. Do NOT translate. (Tags stay lowercase ASCII / kebab-case regardless of input language — they're for cross-language filtering.)

   ID NAMING:
   - Predominantly Chinese source → Chinese id (Han characters). The id MUST preserve the source's specificity — do NOT collapse a long descriptive filename into a single hook word.

     PRESERVE the distinguishing markers from the filename or main topic. Target 6-14 Han characters; if a single concept already covers it (e.g. filename "成长经历.md"), 4 chars are fine.

     Anti-pattern (BAD):
       filename "成本1500，估值1000万？'死了么'APP凭什么火了.md"
       → id "死了么" ❌ (loses cost, valuation, 凭什么火 — three key angles dropped)

     Good:
       → id "死了么app-成本估值复盘" ✅  (keeps app name + the analysis angle)
       → id "死了么-凭什么火"          ✅  (keeps app name + the question angle)

     filename "成长经历.md" → id "成长经历" ✅ (already specific; no compression needed)

     Mechanics: connect multi-concept ids with a single ASCII hyphen. NO spaces, NO punctuation, NO quotes, NO file extension, NO trailing "复盘"/"笔记"/"总结" unless that word is core to the source.

   - Predominantly Japanese / Korean source → Kana / Hangul accordingly, same specificity rule.
   - Otherwise (English / mixed Latin) → kebab-case ASCII: lowercase a-z, digits 0-9, hyphens. No leading hyphen. Same specificity rule (don't compress "the-economics-of-failed-apps" to "failed-apps").

2. WORD LIMIT: \`content\` MUST be under 400 words (or ~600 Chinese characters for CJK content). If the source is longer, drop examples, code excerpts, project history, marketing language, and second-order details. Keep only definitions, patterns, constraints, and core facts.

3. COMPRESSION: For verbose sources (articles, transcripts), aim for compression ratio ≤ 0.3 (output ≤ 30% of input length). For already-dense sources (READMEs, bullet notes), ≤ 0.5 is acceptable but never copy verbatim — always re-condense.

4. STRUCTURE: Use Markdown bullet lists. Drop transitions ("In this section..."), marketing language, first-person voice, timestamps, and self-references like "the document says".

5. CROSS-REFS: Inline references use [[concept-id]] format. If a candidate id from the link table matches, also list it under \`links\`.`;

/**
 * 长文档的"先规划再写"专用 system prompt（plan pass）。
 *
 * 输出一份小 JSON：outline（章节列表）+ target_chars（成品长度上限）。
 * 写正文阶段再用 SYSTEM_PROMPT，但 user message 会把这个 outline 注入进去，
 * 要求 LLM 按节写、不漏节也不加节。
 *
 * 设计取舍：
 *   - 只对 mode='document' 且原文 > LONG_DOC_THRESHOLD_CHARS 的输入触发；
 *     conversation 模式已经按 user/assistant 轮次天然分段，再 plan 就多余了
 *   - plan 失败（网络/JSON 解析错）→ 静默回退到单次生成，绝不让 plan 阶段
 *     把整个 ingest 拖死
 *   - outline 取 3-7 节：太少没有结构化收益，太多反而把模型注意力打散
 */
export const PLAN_SYSTEM_PROMPT = `You are a wiki outliner. Given a long source document, plan ONE wiki entry that another writer will produce next.

Output STRICT JSON in exactly this shape (no commentary, no code fences):

{
  "outline": ["Heading 1", "Heading 2", "Heading 3"],
  "target_chars": 600
}

Rules:

1. OUTLINE: 3-7 short section headings IN THE SOURCE'S LANGUAGE. They will become \`##\` sub-sections in the final Markdown body. Preserve the document's actual structure (definition → mechanism → trade-offs → examples → pitfalls), DO NOT invent sections the source doesn't support. Drop transitions, prefaces, marketing, and acknowledgements.

2. TARGET_CHARS: realistic body length for the final entry. Calibrate by source density:
   - Short note (a tweet-style thought): 200-300
   - Article / blog post: 400-700
   - Long article / chapter / paper: 600-1000
   Stay strictly under 1000 — final body MUST be denser than the source.

3. LANGUAGE: section headings stay in the SAME PRIMARY LANGUAGE as the source. Chinese in → Chinese headings. Do NOT translate.`;

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
  "id": "entry-id",                 // unique slug; see ID rule below
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

3. LANGUAGE: Write \`title\`, \`summary\`, and \`content\` in the SAME PRIMARY LANGUAGE as the conversation. Chinese in → Chinese out. English in → English out. Do NOT translate. (Tags stay lowercase ASCII / kebab-case regardless — they're for cross-language filtering.)

   ID NAMING:
   - Predominantly Chinese conversation → Chinese id (Han characters). Preserve the user's question framing — same rule as title.

     Target 6-14 Han characters. Connect concepts with single ASCII hyphens.

     Good: question about "成长和低谷期" → id "成长与低谷期反思"
     Bad:  same question → id "成长" ❌ (drops 低谷期 angle)

     NO spaces, NO punctuation, NO quotes.

   - Predominantly Japanese / Korean → Kana / Hangul accordingly, same specificity rule.
   - Otherwise → kebab-case ASCII: lowercase a-z, digits 0-9, hyphens; no leading hyphen. Same specificity rule (preserve question markers).

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

/**
 * Hydration 输出 JSON 解析失败的专用错误。
 *
 * 关键字段是 `rawResponse`：把 LLM 的原始输出原样捎出去，让调用方（processJob /
 * runner）能落到 job log 里供排错——否则用户只会看到 "Unexpected token..." 这
 * 种没法定位根因的消息。
 *
 * 触发场景（按经验排序）：
 *   1. provider 不认 `response_format: json_object`（MiniMax / 部分本地模型），
 *      模型把 JSON 包在 markdown 代码块里，或夹带前后散文
 *   2. 模型偏弱在长 prompt 下输出半结构化文本
 *   3. JSON 内含未转义字符 / 截断
 *
 * extractJson 已经尝试过 strip-fence + first-{-to-last-} 两种 rescue，到这一步
 * 是真没救了。
 */
export class HydrationJsonError extends Error {
  readonly rawResponse: string;
  constructor(rawResponse: string, cause?: Error) {
    const preview = rawResponse.length > 200
      ? rawResponse.slice(0, 200) + '…'
      : rawResponse;
    super(
      `Hydration output was not valid JSON (even after rescue attempts). ` +
      `Preview: ${JSON.stringify(preview)}` +
      (cause ? ` — last parser error: ${cause.message}` : ''),
    );
    this.name = 'HydrationJsonError';
    this.rawResponse = rawResponse;
  }
}

/**
 * 从 LLM 输出里抢救 JSON。按"代价递增"顺序试三招：
 *   1. 直接 JSON.parse —— 模型守规矩时 99% 这一步就过
 *   2. 剥 markdown 代码块（```json ... ``` 或裸 ``` ... ```）
 *   3. 取首个 `{` 到末个 `}` 的子串（兜底"前面散文 + 后面 JSON"这种格式）
 *
 * 三招都不行 → 抛 HydrationJsonError，带上原始 text 让调用方落日志。
 *
 * 设计取舍：不做更激进的修复（比如补引号、补逗号）。那会引入"看似 parse 成功
 * 但语义错"的更危险情况；让用户从 raw 日志看到模型实际输出更有价值。
 */
export function extractJson(text: string): unknown {
  let lastErr: Error | undefined;
  try {
    return JSON.parse(text);
  } catch (err) {
    lastErr = err as Error;
  }

  // 剥 markdown 代码块：```json\n{...}\n``` 或 ```\n{...}\n```
  const fenceMatch = text.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch?.[1]) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch (err) {
      lastErr = err as Error;
    }
  }

  // 首 { 到末 }——容忍前后散文 / HTML 包裹
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1));
    } catch (err) {
      lastErr = err as Error;
    }
  }

  throw new HydrationJsonError(text, lastErr);
}

/**
 * Plan pass 的输出 schema。容错：outline 至少 1 节，target_chars 兜底到 600。
 * 验证失败 → runPlan 返 null，写正文阶段无 plan 注入（等价于单次模式）。
 */
const PlanSchema = z.object({
  outline: z.array(z.string().min(1)).min(1).max(12),
  target_chars: z.number().int().positive().max(5000).default(600),
});
type Plan = z.infer<typeof PlanSchema>;

export class HydrationService {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
    private readonly library: LibraryService,
  ) {}

  async hydrate(input: HydrateInput): Promise<Entry> {
    // ── 候选链接来源（与旧版一致）───────────────────────────────────────────
    //   1. 显式注入的 linkCandidates（批量场景，由 runner / batch 一次性 snapshot）
    //   2. autoLink=true 时 library.list 实时取（单文件场景）
    //   3. 都没有 → null（不注入候选）
    const candidatePool: Entry[] | null = input.linkCandidates
      ? input.linkCandidates
      : input.autoLink
        ? this.library.list(input.collectionId)
        : null;

    // ── 候选预筛 ──────────────────────────────────────────────────────────
    // 旧实现把整个 collection 全部喂给 LLM，几百个 entry 就把 prompt 撑到几万 token，
    // 既费钱又稀释信号。这里按"和当前原文关键词重合度"挑 top-N。
    // pool ≤ TOP_N 时不筛（省一次 tokenize），> TOP_N 才走 scoring。
    const filteredCandidates =
      candidatePool && candidatePool.length > TOP_N_LINK_CANDIDATES
        ? topNByQuery(
            this.scoringProbe(input),
            candidatePool,
            TOP_N_LINK_CANDIDATES,
          )
        : candidatePool;
    const candidates = filteredCandidates
      ? filteredCandidates.map((e) => `- ${e.id}: ${e.title} — ${e.summary}`).join('\n')
      : '';

    // ── plan pass（仅长文档 + document 模式）──────────────────────────────
    // conversation 模式靠 Q/A 轮次天然分段，再 plan 就多余且会扭曲问题视角，跳过。
    // plan 失败 → 静默回退到无 plan 模式；绝不让 plan 阶段把 ingest 拖死。
    let plan: Plan | null = null;
    if (input.mode !== 'conversation' && input.rawContent.length > LONG_DOC_THRESHOLD_CHARS) {
      plan = await this.runPlan(input);
    }

    // ── write pass ───────────────────────────────────────────────────────
    const filenameLine = input.filenameHint ? `Filename: ${input.filenameHint}\n\n` : '';
    const planBlock = plan ? this.formatPlanBlock(plan) : '';
    const linksBlock = candidates
      ? `Existing entries you may link to:\n${candidates}\n\n`
      : '';
    const userMessage = `${filenameLine}${planBlock}${linksBlock}Raw input:\n---\n${input.rawContent}\n---`;

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

    // extractJson 会先直 parse，失败时依次试剥 markdown fence、找首 {…末 }。
    // 三招都不行抛 HydrationJsonError，带 rawResponse 字段给 processJob 落日志。
    const parsed = extractJson(text);

    // id 自愈：模型偶尔会照抄文件名输出形如 "华硕Zenbo72p_07" 的 id —— 下划线、
    // 全角字符等会让 HydrationOutputSchema 在 id 正则上挂掉。但我们对文件源
    // 本来就有 deriveIdFromFilename 兜底，没必要为此整条 hydration 失败。
    // 策略：parse 失败时检查是不是"仅 id 字段非法"，是的话用派生 id 覆盖再 parse。
    let out: z.infer<typeof HydrationOutputSchema>;
    try {
      out = HydrationOutputSchema.parse(parsed);
    } catch (err) {
      const onlyIdInvalid =
        err instanceof z.ZodError &&
        err.issues.length > 0 &&
        err.issues.every((i) => i.path[0] === 'id');
      const derivedFallback =
        input.source.type === 'file' && input.filenameHint
          ? deriveIdFromFilename(input.filenameHint)
          : '';
      if (onlyIdInvalid && derivedFallback && parsed && typeof parsed === 'object') {
        out = HydrationOutputSchema.parse({ ...(parsed as object), id: derivedFallback });
      } else {
        throw err;
      }
    }

    // ── id 工程化覆盖 ─────────────────────────────────────────────────────
    // LLM 自选 id 在中文场景下经验性地不稳定（观察到把长文件名压成 2-3 字钩子词）。
    // 当材料是文件且我们拿得到 filename 时，直接确定性派生 id —— filename 已经
    // 承载了源作者精心选择的特异性信息，比 LLM 二次发挥可靠。
    //
    // 回退到 LLM id 的两类场景：
    //   - source.type !== 'file'：inline / conversation / url，没文件名可派生
    //   - 派生结果是空串：filename 全是非法字符（如 "___.md"）；让 LLM 兜底
    let finalId = out.id;
    if (input.source.type === 'file' && input.filenameHint) {
      const derived = deriveIdFromFilename(input.filenameHint);
      if (derived) finalId = derived;
    }

    const compressionRatio =
      input.rawContent.length > 0
        ? Math.min(1, out.content.length / input.rawContent.length)
        : undefined;

    return {
      id: finalId,
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

  /**
   * 给 scoring 用的查询文本：filename + 原文前 N 字符。
   * 取截断而非全文是性能考虑——前 4k 字符的关键词分布足够代表全篇主题。
   */
  private scoringProbe(input: HydrateInput): string {
    const head = input.rawContent.slice(0, SCORING_PROBE_CHARS);
    return input.filenameHint ? `${input.filenameHint} ${head}` : head;
  }

  /**
   * Plan pass：让 LLM 给长文出 outline + 目标长度。失败时返回 null（调用方走 1-pass）。
   *
   * 为什么吞所有异常：plan 是"锦上添花"。网络抖动、JSON 不合规、模型不支持 JSON mode
   * 等任一原因失败都不该让 ingest 整个挂掉——退化到旧行为就好。
   * 失败原因目前不日志化，因为 hydrator 没有 logger 注入；将来若需要排错可在
   * 调用栈外面加 wrapper。
   */
  private async runPlan(input: HydrateInput): Promise<Plan | null> {
    try {
      const userMessage = input.filenameHint
        ? `Filename: ${input.filenameHint}\n\nRaw input:\n---\n${input.rawContent}\n---`
        : `Raw input:\n---\n${input.rawContent}\n---`;
      const completion = await this.client.chat.completions.create({
        model: this.model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: PLAN_SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
      });
      const text = completion.choices[0]?.message?.content;
      if (!text) return null;
      // plan 阶段也用 extractJson：MiniMax 之类不严格 JSON mode 的 provider 同样
      // 倾向于把 plan 包在 markdown fence 里。失败仍静默回退到无 plan 模式。
      const parsed: unknown = extractJson(text);
      return PlanSchema.parse(parsed);
    } catch {
      return null;
    }
  }

  /**
   * 把 plan 渲染成 write pass user message 里的一段指令。
   * 关键措辞 "do not drop sections / do not add new ones" 是为了把 plan 真正变成
   * 硬约束而不是建议——否则模型常常会忽略 outline 自己重新组织。
   */
  private formatPlanBlock(plan: Plan): string {
    const lines = plan.outline.map((s, i) => `${i + 1}. ${s}`).join('\n');
    return (
      `Plan (the writer must follow this outline; do not drop sections, do not add new ones):\n` +
      `${lines}\n` +
      `Target body length: ~${plan.target_chars} characters.\n\n`
    );
  }
}
