import { TransactionTypeEnum, TransactionStatusEnum, CategoryEnum } from './transaction.enum';

export interface ITransaction {
  id: number;
  userId: number;
  emailConnectionId: number | null;
  bankId: number | null;
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
  createdAt: Date;
  updatedAt: Date;
}

export interface ICreateTransaction {
  userId: number;
  emailConnectionId?: number;
  bankId?: number;
  parserTemplateId?: number;
  gmailMessageId?: string;
  merchant: string;
  category: CategoryEnum;
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
  category?: CategoryEnum;
  currency?: string;
  bankId?: number;
  status?: TransactionStatusEnum;
  dateFrom?: Date;
  dateTo?: Date;
  search?: string;
}
