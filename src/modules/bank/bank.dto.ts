import { z } from 'zod';

export const BankResponseSchema = z.object({
  id: z.number(),
  name: z.string(),
  short_code: z.string(),
  country: z.string().nullable(),
  known_sender_emails: z.array(z.string()),
  logo_url: z.string().nullable(),
  is_active: z.boolean(),
});
export type BankResponseDTO = z.infer<typeof BankResponseSchema>;
