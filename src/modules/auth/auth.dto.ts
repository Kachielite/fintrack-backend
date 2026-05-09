import { z } from 'zod';

export const GoogleAuthSchema = z.object({
  id_token: z.string().min(1),
});
export type GoogleAuthDTO = z.infer<typeof GoogleAuthSchema>;

export const AppleAuthSchema = z.object({
  id_token: z.string().min(1),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
});
export type AppleAuthDTO = z.infer<typeof AppleAuthSchema>;

export const RefreshTokenSchema = z.object({
  refresh_token: z.string().min(1),
});
export type RefreshTokenDTO = z.infer<typeof RefreshTokenSchema>;

export const AuthResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  user: z.object({
    id: z.number(),
    email: z.string(),
    first_name: z.string(),
    onboarding_complete: z.boolean(),
  }),
});
export type AuthResponseDTO = z.infer<typeof AuthResponseSchema>;
