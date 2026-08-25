import { z } from 'zod';

export const CreateCategorySchema = z.object({
  name: z.string().min(1).max(60),
  icon: z.string().min(1).max(50).optional(),
  type: z.enum(['expense', 'income']).default('expense'),
});
export type CreateCategoryDTO = z.infer<typeof CreateCategorySchema>;

export const UpdateCategorySchema = z
  .object({
    name: z.string().min(1).max(60).optional(),
    icon: z.string().min(1).max(50).optional(),
    type: z.enum(['expense', 'income']).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'At least one field must be provided' });
export type UpdateCategoryDTO = z.infer<typeof UpdateCategorySchema>;
