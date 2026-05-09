import { InsightTypeEnum } from './insight.enum';

export interface IInsight {
  id: number;
  userId: number;
  type: string;
  message: string;
  contextData: unknown;
  isRead: boolean;
  expiresAt: Date | null;
  createdAt: Date;
}
