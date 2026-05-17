import { CONSTANTS } from '@/common/configuration/constants';
import logger from '@/common/lib/logger';

const ONESIGNAL_API = 'https://onesignal.com/api/v1/notifications';

export async function sendPushNotification(
  playerIds: string[],
  title: string,
  body: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  if (!CONSTANTS.ONESIGNAL_APP_ID || !CONSTANTS.ONESIGNAL_REST_API_KEY) {
    logger.warn('[Push] OneSignal not configured — skipping push notification');
    return;
  }
  if (playerIds.length === 0) return;

  try {
    const res = await fetch(ONESIGNAL_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Key ${CONSTANTS.ONESIGNAL_REST_API_KEY}`,
      },
      body: JSON.stringify({
        app_id: CONSTANTS.ONESIGNAL_APP_ID,
        include_player_ids: playerIds,
        headings: { en: title },
        contents: { en: body },
        data,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.error(`[Push] OneSignal error ${res.status}: ${text}`);
      return;
    }

    logger.info(`[Push] Sent to ${playerIds.length} device(s): "${title}"`);
  } catch (error) {
    logger.error(`[Push] Failed to send: ${error}`);
  }
}
