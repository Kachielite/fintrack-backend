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
  passwordHash: string | null;
  planTier: string;
  dataRetentionMonths: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ICreateUser {
  email: string;
  firstName: string;
  lastName?: string;
  passwordHash?: string;
}

export interface IUpdateUser {
  firstName?: string;
  lastName?: string;
  refCurrency?: CurrencyEnum;
  advisorTone?: AdvisorToneEnum;
  goalType?: GoalTypeEnum;
  incomeRange?: string;
  payFrequency?: PayFrequencyEnum;
}

export interface ICompleteOnboarding {
  goalType: GoalTypeEnum;
  incomeRange: string;
  payFrequency: PayFrequencyEnum;
  refCurrency: CurrencyEnum;
}
