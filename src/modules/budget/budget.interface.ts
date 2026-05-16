import { BudgetPeriodEnum } from './budget.enum';

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
  habitDescription: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ICreateBudget {
  userId: number;
  category: string;
  limitAmount: number;
  currency: string;
  periodType: BudgetPeriodEnum;
  isSuggestedByAi?: boolean;
  habitDescription?: string | null;
}
