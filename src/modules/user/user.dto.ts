import { z } from 'zod';
import { GoalTypeEnum, PayFrequencyEnum, AdvisorToneEnum, CurrencyEnum } from './user.enum';

export const UpdateUserSchema = z.object({
  first_name: z.string().min(1).optional(),
  last_name: z.string().optional(),
  ref_currency: z.nativeEnum(CurrencyEnum).optional(),
  advisor_tone: z.nativeEnum(AdvisorToneEnum).optional(),
});
export type UpdateUserDTO = z.infer<typeof UpdateUserSchema>;

export const CompleteOnboardingSchema = z.object({
  goal_type: z.nativeEnum(GoalTypeEnum),
  income_range: z.string().min(1),
  pay_frequency: z.nativeEnum(PayFrequencyEnum),
  ref_currency: z.nativeEnum(CurrencyEnum),
});
export type CompleteOnboardingDTO = z.infer<typeof CompleteOnboardingSchema>;

export const UserResponseSchema = z.object({
  id: z.number(),
  email: z.string(),
  first_name: z.string(),
  last_name: z.string().nullable(),
  ref_currency: z.string(),
  advisor_tone: z.string(),
  goal_type: z.string().nullable(),
  income_range: z.string().nullable(),
  pay_frequency: z.string().nullable(),
  onboarding_complete: z.boolean(),
  plan_tier: z.string(),
  created_at: z.date(),
});
export type UserResponseDTO = z.infer<typeof UserResponseSchema>;
