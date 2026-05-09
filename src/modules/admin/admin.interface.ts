export interface IAiUsageLog {
  id: number;
  operation: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  modelUsed: string;
  userId: number | null;
  transactionId: number | null;
  templateId: number | null;
  createdAt: Date;
}

export interface ILogAiUsage {
  operation: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  modelUsed: string;
  userId?: number | null;
  transactionId?: number | null;
  templateId?: number | null;
}

export interface IAdminUser {
  id: number;
  email: string;
  passwordHash: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}
