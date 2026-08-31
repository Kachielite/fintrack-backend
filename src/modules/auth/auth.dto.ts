import { z } from 'zod';

export const GoogleAuthSchema = z.object({
  id_token: z.string().min(1),
  // Only enforced when this sign-in creates a brand-new account (see
  // AuthService.upsertUserAndIssueTokens) — a returning user has already
  // consented, so this stays optional at the schema level.
  terms_accepted: z.boolean().optional(),
});
export type GoogleAuthDTO = z.infer<typeof GoogleAuthSchema>;

export const AppleAuthSchema = z.object({
  id_token: z.string().min(1),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  terms_accepted: z.boolean().optional(),
});
export type AppleAuthDTO = z.infer<typeof AppleAuthSchema>;

export const RefreshTokenSchema = z.object({
  refresh_token: z.string().min(1),
});
export type RefreshTokenDTO = z.infer<typeof RefreshTokenSchema>;

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginDTO = z.infer<typeof LoginSchema>;

export const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  first_name: z.string().min(1, 'First name is required'),
  last_name: z.string().optional(),
  terms_accepted: z.literal(true, {
    message: 'You must accept the terms and privacy policy to create an account',
  }),
});
export type RegisterDTO = z.infer<typeof RegisterSchema>;

export const AuthResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  user: z.object({
    id: z.number(),
    email: z.string(),
    first_name: z.string(),
    onboarding_complete: z.boolean(),
  }),
  reactivated: z.boolean().optional(),
});
export type AuthResponseDTO = z.infer<typeof AuthResponseSchema>;
