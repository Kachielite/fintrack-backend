import { z } from 'zod';
import { TransactionTypeEnum, TransactionStatusEnum } from './transaction.enum';

export const CorrectTransactionSchema = z.object({
  merchant: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  transaction_type: z.nativeEnum(TransactionTypeEnum).optional(),
  amount: z.number().optional(),
});
export type CorrectTransactionDTO = z.infer<typeof CorrectTransactionSchema>;

export const TransactionQuerySchema = z.object({
  page: z.coerce.number().default(1),
  limit: z.coerce.number().default(20),
  category: z.string().optional(),
  currency: z.string().optional(),
  bank_id: z.coerce.number().optional(),
  status: z.nativeEnum(TransactionStatusEnum).optional(),
  date_from: z.string().datetime().optional(),
  date_to: z.string().datetime().optional(),
  search: z.string().optional(),
});
export type TransactionQueryDTO = z.infer<typeof TransactionQuerySchema>;

export const TransactionSummaryQuerySchema = z.object({
  year: z.coerce.number().optional(),
  month: z.coerce.number().min(1).max(12).optional(),
});

export const ChartDataQuerySchema = z.object({
  period: z.enum(['1m', '3m', '6m']).default('1m'),
});
export type ChartDataQueryDTO = z.infer<typeof ChartDataQuerySchema>;

export const BulkCategorySchema = z.object({
  ids: z.array(z.number().int().positive()).min(1),
  category: z.string().min(1),
});
export type BulkCategoryDTO = z.infer<typeof BulkCategorySchema>;
