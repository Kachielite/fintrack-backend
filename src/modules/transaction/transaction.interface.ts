import { TransactionTypeEnum, TransactionStatusEnum } from './transaction.enum';

export interface ITransaction {
  id: number;
  userId: number;
  emailConnectionId: number | null;
  bankId: number | null;
  accountId: number | null;
  parserTemplateId: number | null;
  gmailMessageId: string | null;
  merchant: string;
  category: string;
  transactionType: string;
  amount: number;
  currency: string;
  refAmount: number;
  refCurrency: string;
  exchangeRateUsed: number | null;
  transactionDate: Date;
  status: string;
  originalMerchant: string | null;
  originalCategory: string | null;
  reference: string | null;
  balance: number | null;
  excludeFromTotals: boolean;
  createdAt: Date;
  updatedAt: Date;
  // Joined bank fields — present on getTransaction detail, absent on list queries
  bankName?: string | null;
  bankShortCode?: string | null;
  bankLogoUrl?: string | null;
}

export interface ICreateTransaction {
  userId: number;
  emailConnectionId?: number;
  bankId?: number;
  accountId?: number;
  parserTemplateId?: number;
  gmailMessageId?: string;
  merchant: string;
  originalMerchant?: string;
  category: string;
  transactionType: TransactionTypeEnum;
  amount: number;
  currency: string;
  refAmount: number;
  refCurrency: string;
  exchangeRateUsed?: number;
  transactionDate: Date;
  status: TransactionStatusEnum;
  reference?: string;
  balance?: number;
}

export interface ITransactionFilter {
  userId: number;
  page: number;
  limit: number;
  category?: string;
  currency?: string;
  bankId?: number;
  status?: string;
  dateFrom?: Date;
  dateTo?: Date;
  search?: string;
}

export interface IDailySpendPoint {
  date: string;
  spend: number;
  income: number;
}

export interface IDailySpendDetail extends IDailySpendPoint {
  net: number;
}

export interface IMonthSpendSummary {
  spend: number;
  income: number;
  net: number;
}
