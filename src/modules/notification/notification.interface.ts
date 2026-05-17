export type NotificationType =
  | 'sync_complete'
  | 'sync_skipped'
  | 'sync_failed'
  | 'insight_generated';

export interface INotification {
  id: number;
  userId: number;
  type: NotificationType;
  title: string;
  body: string;
  data: string | null; // JSON string
  readAt: Date | null;
  createdAt: Date;
}

export interface ICreateNotification {
  userId: number;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface IDeviceToken {
  id: number;
  userId: number;
  playerId: string;
  platform: string | null;
  createdAt: Date;
}
