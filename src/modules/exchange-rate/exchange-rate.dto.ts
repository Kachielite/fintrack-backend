import { z } from 'zod';

export const ExchangeRateResponseSchema = z.object({
  base_currency: z.string(),
  target_currency: z.string(),
  rate: z.number(),
  fetched_at: z.date(),
});
export type ExchangeRateResponseDTO = z.infer<typeof ExchangeRateResponseSchema>;
