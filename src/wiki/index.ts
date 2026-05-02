export { LibraryService, type LibraryServiceOptions, type LinkIndexEntry } from './library.js';
export {
  HydrationService,
  type HydrateInput,
  SYSTEM_PROMPT as HYDRATION_SYSTEM_PROMPT,
  CONVERSATION_SYSTEM_PROMPT,
} from './hydration.js';
export { ContextAssembler, type QueryResult, type ReferencedEntry } from './assembler.js';
export {
  EntrySchema,
  SourceSchema,
  HydrationOutputSchema,
  type Entry,
  type Source,
  type HydrationOutput,
} from './types.js';
export { runBatch, type BatchOptions, type BatchSummary, type FileResult } from './batch.js';
