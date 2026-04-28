import { z } from 'zod';

export const SourceSchema = z.object({
  type: z.enum(['url', 'file', 'inline', 'unknown']),
  value: z.string().optional(),
});

export const EntrySchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be kebab-case slug'),
  collection: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().default(''),
  tags: z.array(z.string()).default([]),
  links: z.array(z.string()).default([]),
  content: z.string(),
  source: SourceSchema.default({ type: 'unknown' }),
  updated: z.string(),
  compressionRatio: z.number().min(0).max(1).optional(),
});

export type Entry = z.infer<typeof EntrySchema>;
export type Source = z.infer<typeof SourceSchema>;

export const HydrationOutputSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1),
  summary: z.string().default(''),
  tags: z.array(z.string()).default([]),
  links: z.array(z.string()).default([]),
  content: z.string().min(1),
});
export type HydrationOutput = z.infer<typeof HydrationOutputSchema>;
