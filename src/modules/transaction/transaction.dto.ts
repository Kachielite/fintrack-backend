import { z } from 'zod';
import { TransactionTypeEnum, TransactionStatusEnum } from './transaction.enum';

export const CorrectTransactionSchema = z.object({
  merchant: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  transaction_type: z.nativeEnum(TransactionTypeEnum).optional(),
  amount: z.number().optional(),
});
export type CorrectTransactionDTO = z.infer<typeof CorrectTransactionSchema>;

// The frontend's filter UI is inherently multi-select for category, currency,
// bank, and account - accept a comma-separated list for each (a single value
// with no comma still works as a 1-element list) rather than forcing the
// client to filter client-side against whatever's already loaded, which
// silently misses matches outside the current page cache. See
// fintrack-backend#138.
const stringList = z
  .string()
  .transform((val) => val.split(',').map((s) => s.trim()).filter(Boolean))
  .optional();
const numberList = z
  .string()
  .transform((val) => val.split(',').map((s) => Number(s.trim())).filter((n) => !isNaN(n)))
  .optional();

export const TransactionQuerySchema = z.object({
  page: z.coerce.number().default(1),
  limit: z.coerce.number().default(20),
  category: stringList,
  currency: stringList,
  bank_id: numberList,
  account_id: numberList,
  status: z.nativeEnum(TransactionStatusEnum).optional(),
  date_from: z.string().datetime().optional(),
  date_to: z.string().datetime().optional(),
  search: z.string().optional(),
  exclude_from_totals: z.coerce.boolean().optional(),
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

export const MarkTransferSchema = z.object({
  linked_transaction_id: z.number().int().positive().optional(),
  remember: z.boolean().optional(),
});
export type MarkTransferDTO = z.infer<typeof MarkTransferSchema>;

export const UnmarkTransferSchema = z.object({
  remember: z.boolean().optional(),
});
export type UnmarkTransferDTO = z.infer<typeof UnmarkTransferSchema>;

export const CreateManualTransactionSchema = z.object({
  merchant: z.string().min(1),
  category: z.string().min(1),
  transaction_type: z.nativeEnum(TransactionTypeEnum),
  amount: z.number().positive(),
  currency: z.string().length(3),
  transaction_date: z.string().datetime(),
  account_id: z.number().int().positive().optional(),
  reference: z.string().optional(),
  balance: z.number().optional(),
});
export type CreateManualTransactionDTO = z.infer<typeof CreateManualTransactionSchema>;

