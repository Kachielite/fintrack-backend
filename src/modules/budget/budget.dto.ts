import { z } from 'zod';
import { BudgetPeriodEnum } from './budget.enum';
import { CategoryEnum } from '@/modules/transaction/transaction.enum';

export const CreateBudgetSchema = z.object({
  category: z.nativeEnum(CategoryEnum),
  limit_amount: z.number().positive(),
  currency: z.string(),
  period_type: z.nativeEnum(BudgetPeriodEnum).default(BudgetPeriodEnum.MONTHLY),
});
export type CreateBudgetDTO = z.infer<typeof CreateBudgetSchema>;

export const UpdateBudgetSchema = z.object({
  limit_amount: z.number().positive().optional(),
  period_type: z.nativeEnum(BudgetPeriodEnum).optional(),
  is_active: z.boolean().optional(),
});
export type UpdateBudgetDTO = z.infer<typeof UpdateBudgetSchema>;

export const BudgetWithProgressSchema = z.object({
  id: z.number(),
  category: z.string(),
  limit_amount: z.number(),
  currency: z.string(),
  period_type: z.string(),
  spent: z.number(),
  remaining: z.number(),
  percentage: z.number(),
  status: z.enum(['healthy', 'warning', 'over']),
  days_remaining: z.number(),
  habit_description: z.string().nullable().optional(),
});
export type BudgetWithProgressDTO = z.infer<typeof BudgetWithProgressSchema>;

export type AutoGenerateResultDTO = {
  created: BudgetWithProgressDTO[];
  skipped: string[];
};

export const BudgetDetailSchema = z.object({
  id: z.number(),
  category: z.string(),
  limit_amount: z.number(),
  currency: z.string(),
  period_type: z.string(),
  is_suggested_by_ai: z.boolean(),
  spent: z.number(),
  remaining: z.number(),
  percentage: z.number(),
  status: z.enum(['healthy', 'warning', 'over']),
  days_remaining: z.number(),
  transaction_count: z.number(),
  merchant_breakdown: z.array(z.object({
    merchant: z.string(),
    total: z.number(),
    percentage_of_budget: z.number(),
    transaction_count: z.number(),
  })),
  transactions: z.array(z.object({
    date_group: z.string(),
    items: z.array(z.object({
      id: z.number(),
      merchant: z.string(),
      bank: z.string(),
      amount: z.number(),
      currency: z.string(),
      ref_amount: z.number(),
      time: z.string(),
      status: z.string(),
    })),
  })),
});
export type BudgetDetailDTO = z.infer<typeof BudgetDetailSchema>;
