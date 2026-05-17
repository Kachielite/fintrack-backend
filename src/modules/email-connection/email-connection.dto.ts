import { z } from 'zod';

export const GmailCallbackSchema = z.object({
  code: z.string().min(1),
  redirect_uri: z.string().url(),
});
export type GmailCallbackDTO = z.infer<typeof GmailCallbackSchema>;

export const EmailConnectionResponseSchema = z.object({
  id: z.number(),
  gmail_address: z.string(),
  status: z.string(),
  gmail_label_id: z.string().nullable(),
  gmail_label_name: z.string().nullable(),
  last_synced_at: z.date().nullable(),
  created_at: z.date(),
  already_connected: z.boolean().optional(),
});
export type EmailConnectionResponseDTO = z.infer<typeof EmailConnectionResponseSchema>;
