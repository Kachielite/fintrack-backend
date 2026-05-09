import { z } from 'zod';
import { RuleStatusEnum } from './parser-rule.enum';

export const ParserTemplateResponseSchema = z.object({
  id: z.number(),
  bank_id: z.number(),
  version: z.number(),
  description: z.string().nullable(),
  status: z.nativeEnum(RuleStatusEnum),
  confidence_score: z.number(),
  match_count: z.number(),
  fail_count: z.number(),
});
export type ParserTemplateResponseDTO = z.infer<typeof ParserTemplateResponseSchema>;
