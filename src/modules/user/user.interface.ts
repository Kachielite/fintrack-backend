import { GoalTypeEnum, PayFrequencyEnum, AdvisorToneEnum, CurrencyEnum } from './user.enum';

export interface IUser {
  id: number;
  email: string;
  firstName: string;
  lastName: string | null;
  refCurrency: string;
  advisorTone: string;
  goalType: string | null;
  incomeRange: string | null;
  payFrequency: string | null;
  onboardingComplete: boolean;
  refreshTokenHash: string | null;
  demoPasswordHash: string | null;
  planTier: string;
  dataRetentionMonths: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ICreateUser {
  email: string;
  firstName: string;
  lastName?: string;
}

export interface IUpdateUser {
  firstName?: string;
  lastName?: string;
  refCurrency?: CurrencyEnum;
  advisorTone?: AdvisorToneEnum;
}

export interface ICompleteOnboarding {
  goalType: GoalTypeEnum;
  incomeRange: string;
  payFrequency: PayFrequencyEnum;
  refCurrency: CurrencyEnum;
}
