import { ConnectionStatusEnum } from './email-connection.enum';

export interface IEmailConnection {
  id: number;
  userId: number;
  provider: string;
  gmailAddress: string;
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  tokenExpiresAt: Date;
  gmailLabelId: string | null;
  gmailLabelName: string | null;
  status: string;
  lastSyncedAt: Date | null;
  lastSyncMessageCount: number | null;
  backfillPending: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ICreateEmailConnection {
  userId: number;
  gmailAddress: string;
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  tokenExpiresAt: Date;
  gmailLabelId?: string;
  gmailLabelName?: string;
  status?: string;
}

export interface IUpdateEmailConnection {
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  tokenExpiresAt: Date;
  gmailLabelId: string;
  gmailLabelName: string;
  status: string;
}

export interface IUpdateLabel {
  gmailLabelId: string;
  gmailLabelName: string;
}
