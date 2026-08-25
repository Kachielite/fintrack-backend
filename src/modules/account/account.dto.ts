import { z } from 'zod';

export const AccountResponseSchema = z.object({
  id: z.number(),
  bank_id: z.number().nullable(),
  bank_name: z.string().nullable(),
  bank_logo_url: z.string().nullable(),
  currency: z.string(),
  label: z.string(),
  account_number_mask: z.string().nullable(),
  is_active: z.boolean(),
  balance: z.number().nullable(),
  last_synced_at: z.string().nullable(),
  created_at: z.string(),
});
export type AccountResponseDTO = z.infer<typeof AccountResponseSchema>;

export const PatchAccountSchema = z
  .object({
    label: z.string().min(1).max(100).optional(),
    is_active: z.boolean().optional(),
    merge_into_account_id: z.number().int().positive().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'At least one field must be provided' });
export type PatchAccountDTO = z.infer<typeof PatchAccountSchema>;
