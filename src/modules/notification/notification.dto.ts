import { INotification } from './notification.interface';

export interface NotificationResponseDto {
  id: number;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

export interface UnreadCountDto {
  count: number;
}

export function mapNotificationToDto(n: INotification): NotificationResponseDto {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    data: n.data ? JSON.parse(n.data) : null,
    readAt: n.readAt ? n.readAt.toISOString() : null,
    createdAt: n.createdAt.toISOString(),
  };
}
