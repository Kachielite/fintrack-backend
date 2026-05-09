import { z } from 'zod';
import { GoalTypeEnum } from '@/modules/user/user.enum';

export const CreateGoalSchema = z.object({
  name: z.string().min(1),
  type: z.nativeEnum(GoalTypeEnum),
  target_amount: z.number().positive().optional(),
  currency: z.string().min(1),
  target_date: z.string().datetime().optional(),
});
export type CreateGoalDTO = z.infer<typeof CreateGoalSchema>;

export const UpdateGoalSchema = z.object({
  name: z.string().min(1).optional(),
  target_amount: z.number().positive().optional(),
  saved_amount: z.number().min(0).optional(),
  target_date: z.string().datetime().optional(),
});
export type UpdateGoalDTO = z.infer<typeof UpdateGoalSchema>;
