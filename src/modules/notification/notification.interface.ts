export type NotificationType = 'sync_complete' | 'sync_skipped' | 'sync_failed';

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
