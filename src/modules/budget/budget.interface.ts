import { BudgetPeriodEnum } from './budget.enum';
import { CategoryEnum } from '@/modules/transaction/transaction.enum';

export interface IBudget {
  id: number;
  userId: number;
  category: string;
  limitAmount: number;
  currency: string;
  periodType: string;
  isActive: boolean;
  isSuggestedByAi: boolean;
  suppressedSuggestionsUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ICreateBudget {
  userId: number;
  category: CategoryEnum;
  limitAmount: number;
  currency: string;
  periodType: BudgetPeriodEnum;
  isSuggestedByAi?: boolean;
}
