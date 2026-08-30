import { InsightTypeEnum } from './insight.enum';

export type InsightPeriodType = 'weekly' | 'monthly';

export interface IInsight {
  id: number;
  userId: number;
  type: string;
  message: string;
  contextData: unknown;
  periodType: InsightPeriodType | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  isRead: boolean;
  expiresAt: Date | null;
  createdAt: Date;
}
