import { z } from 'zod';

export const InsightQuerySchema = z.object({
  unread_only: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});
export type InsightQueryDTO = z.infer<typeof InsightQuerySchema>;
