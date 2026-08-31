import { inject, injectable } from 'tsyringe';
import { google, gmail_v1 } from 'googleapis';
import { CONSTANTS } from '@/common/configuration/constants';
import { tokenEncryptionService } from '@/common/utils/token-encryption';
import {
  InternalServerException,
  PlanLimitException,
  ResourceNotFoundException,
} from '@/common/exception';
import logger from '@/common/lib/logger';
import { IEmailConnectionRepository } from './email-connection.repository';
import { IIngestionRepository } from '@/modules/ingestion/ingestion.repository';
import { IConnectionStats } from '@/modules/ingestion/ingestion.interface';
import { IBudgetRepository } from '@/modules/budget/budget.repository';
import { IInsightRepository } from '@/modules/insight/insight.repository';
import AccountService, { IAccountService } from '@/modules/account/account.service';
import { IUserRepository } from '@/modules/user/user.repository';
import { getMaxEmailConnectionsForPlan } from '@/modules/user/user.constants';
import {
  GmailCallbackDTO,
  EmailConnectionResponseDTO,
} from './email-connection.dto';
import { IEmailConnection } from './email-connection.interface';
import { ConnectionStatusEnum } from './email-connection.enum';
import { IGeneralResponse } from '@/common/types/interface';

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic',
];

const UNIVERSAL_FILTER_QUERY =
  'subject:(debit OR credit OR debited OR credited OR "transaction alert" OR ' +
  '"account alert" OR "payment alert" OR "transfer alert" OR ' +
  '"transaction notification" OR "you have sent" OR "you have received" OR ' +
  '"payment received" OR "payment sent" OR "funds received" OR ' +
  '"funds transferred" OR withdrawal) ' +
  '-has:attachment -subject:(statement OR OTP OR "one-time" OR password OR promo OR newsletter OR offer)';

const GMAIL_LABEL_NAME = 'Bank Transactions';
const BACKFILL_MAX_MESSAGES = 500;

export class GmailAuthRevokedError extends Error {
  constructor(public readonly connectionId: number) {
    super(`Gmail auth revoked for connection ${connectionId} — user must reconnect`);
    this.name = 'GmailAuthRevokedError';
  }
}

export interface IEmailConnectionService {
  getAuthUrl(userId: number): string;
  handleCallback(userId: number, data: GmailCallbackDTO): Promise<EmailConnectionResponseDTO>;
  listConnections(userId: number): Promise<EmailConnectionResponseDTO[]>;
  getConnection(id: number, userId: number): Promise<EmailConnectionResponseDTO>;
  triggerSync(id: number, userId: number): Promise<IGeneralResponse<null>>;
  getStats(id: number, userId: number): Promise<IConnectionStats>;
  deleteConnectionData(id: number, userId: number): Promise<IGeneralResponse<null>>;
  deleteConnection(id: number, userId: number): Promise<IGeneralResponse<null>>;
  getOAuth2Client(connection: IEmailConnection): Promise<any>;
  addSenderFilterAndResync(userId: number, senderEmail: string): Promise<void>;
}

@injectable()
class EmailConnectionService implements IEmailConnectionService {
  constructor(
    @inject('IEmailConnectionRepository')
    private connectionRepository: IEmailConnectionRepository,
    @inject('IIngestionRepository')
    private ingestionRepository: IIngestionRepository,
    @inject('IBudgetRepository')
    private budgetRepository: IBudgetRepository,
    @inject('IInsightRepository')
    private insightRepository: IInsightRepository,
    @inject(AccountService)
    private accountService: IAccountService,
    @inject('IUserRepository')
    private userRepository: IUserRepository,
  ) {}

  getAuthUrl(userId: number): string {
    logger.info(`[Gmail OAuth] GOOGLE_REDIRECT_URI = "${CONSTANTS.GOOGLE_REDIRECT_URI}"`);
    const oauth2Client = this.createOAuth2Client();
    const state = Buffer.from(JSON.stringify({ userId })).toString('base64url');
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: GMAIL_SCOPES,
      prompt: 'consent',
      state,
    });
    logger.info(`[Gmail OAuth] Generated auth URL redirect_uri param = "${new URL(url).searchParams.get('redirect_uri')}"`);
    return url;
  }

  async handleCallback(userId: number, data: GmailCallbackDTO): Promise<EmailConnectionResponseDTO> {
    try {
      const oauth2Client = this.createOAuth2Client(data.redirect_uri);
      const { tokens } = await oauth2Client.getToken(data.code);

      if (!tokens.access_token || !tokens.refresh_token) {
        throw new InternalServerException('Failed to retrieve OAuth tokens');
      }

      oauth2Client.setCredentials(tokens);
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

      const profile = await gmail.users.getProfile({ userId: 'me' });
      const gmailAddress = profile.data.emailAddress as string;

      const existing = await this.connectionRepository.findByUserAndEmail(userId, gmailAddress);

      if (!existing) {
        // A brand-new distinct address: enforce the plan's connection cap here,
        // before touching the user's real Gmail account (label/filter), since
        // this is the authoritative gate — the frontend's own pre-check (if
        // any) may be stale or bypassed, and OAuth has already completed by
        // this point regardless.
        const user = await this.userRepository.findById(userId);
        const maxConnections = getMaxEmailConnectionsForPlan(user?.planTier ?? 'free');
        if (maxConnections !== null) {
          const userConnections = await this.connectionRepository.findAllByUser(userId);
          // Revoked connections don't count against the cap — the user can
          // reconnect the same address, or connect a different one, once
          // they've revoked the old one.
          const nonRevokedCount = userConnections.filter(
            (c) => c.status !== ConnectionStatusEnum.REVOKED,
          ).length;
          if (nonRevokedCount >= maxConnections) {
            throw new PlanLimitException(
              `Free plan is limited to ${maxConnections} email connection${maxConnections === 1 ? '' : 's'}. Upgrade to Pro for unlimited connections.`,
              'PLAN_LIMIT_EMAIL_CONNECTIONS',
            );
          }
        }
      }

      const labelId = await this.findOrCreateLabel(gmail, GMAIL_LABEL_NAME);
      await this.createGmailFilter(gmail, labelId);

      const encryptedAccessToken = tokenEncryptionService.encrypt(tokens.access_token);
      const encryptedRefreshToken = tokenEncryptionService.encrypt(tokens.refresh_token);
      const tokenExpiresAt = new Date(tokens.expiry_date || Date.now() + 3600 * 1000);

      let connection: IEmailConnection;
      let alreadyConnected = false;

      if (existing) {
        // Refresh tokens for an existing connection (re-auth) without treating it as new.
        alreadyConnected = true;
        connection = await this.connectionRepository.update(existing.id, {
          encryptedAccessToken,
          encryptedRefreshToken,
          tokenExpiresAt,
          gmailLabelId: labelId,
          gmailLabelName: GMAIL_LABEL_NAME,
          status: ConnectionStatusEnum.ACTIVE,
        });
      } else {
        connection = await this.connectionRepository.create({
          userId,
          gmailAddress,
          encryptedAccessToken,
          encryptedRefreshToken,
          tokenExpiresAt,
          gmailLabelId: labelId,
          gmailLabelName: GMAIL_LABEL_NAME,
          status: ConnectionStatusEnum.ACTIVE,
        });
      }

      this.backfillExistingEmails(connection.id, labelId, oauth2Client).catch((err) => {
        logger.error(`[EmailConnection] Backfill failed for connection ${connection.id}: ${err?.message}`);
      });

      return { ...this.mapToDTO(connection), already_connected: alreadyConnected };
    } catch (error) {
      if (error instanceof PlanLimitException) throw error;
      logger.error(`Gmail callback error for userId ${userId} - ${error}`);
      throw new InternalServerException('Failed to connect Gmail account');
    }
  }

  async listConnections(userId: number): Promise<EmailConnectionResponseDTO[]> {
    try {
      const connections = await this.connectionRepository.findAllByUser(userId);
      return connections.map((c) => this.mapToDTO(c));
    } catch (error) {
      logger.error(`Error listing connections for user ${userId} - ${error}`);
      throw new InternalServerException('Failed to list email connections');
    }
  }

  async getConnection(id: number, userId: number): Promise<EmailConnectionResponseDTO> {
    try {
      const connection = await this.connectionRepository.findById(id, userId);
      if (!connection) throw new ResourceNotFoundException('Email connection not found');
      return this.mapToDTO(connection);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) throw error;
      logger.error(`Error fetching connection ${id} - ${error}`);
      throw new InternalServerException('Failed to fetch email connection');
    }
  }

  async triggerSync(id: number, userId: number): Promise<IGeneralResponse<null>> {
    try {
      const connection = await this.connectionRepository.findById(id, userId);
      if (!connection) throw new ResourceNotFoundException('Email connection not found');

      // Capture label info before entering the async callback.
      const labelId = connection.gmailLabelId;

      setImmediate(async () => {
        // Re-apply the Gmail label to any matching emails that arrived since the last sync.
        // This ensures newly matched emails are in the label before polling fetches them.
        if (labelId) {
          try {
            const oauth2Client = await this.getOAuth2Client(connection);
            await this.backfillExistingEmails(id, labelId, oauth2Client);
          } catch (err) {
            logger.error(`[EmailConnection] Re-label step failed for connection ${id}: ${err}`);
          }
        }

        const { container } = require('tsyringe');
        const IngestionService = require('@/modules/ingestion/ingestion.service').default;
        const ingestionService = container.resolve(IngestionService);
        ingestionService.enqueuePoll(id, 'manual').catch((err: unknown) => {
          logger.error(`Background manual sync failed for connection ${id} - ${err}`);
        });
      });

      return { success: true, message: 'Sync started', data: null };
    } catch (error) {
      if (error instanceof ResourceNotFoundException) throw error;
      logger.error(`Error triggering sync for connection ${id} - ${error}`);
      throw new InternalServerException('Failed to trigger sync');
    }
  }

  async getStats(id: number, userId: number): Promise<IConnectionStats> {
    try {
      const connection = await this.connectionRepository.findById(id, userId);
      if (!connection) throw new ResourceNotFoundException('Email connection not found');
      return await this.ingestionRepository.getConnectionStats(id);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) throw error;
      logger.error(`Error fetching stats for connection ${id} - ${error}`);
      throw new InternalServerException('Failed to fetch connection stats');
    }
  }

  async deleteConnectionData(id: number, userId: number): Promise<IGeneralResponse<null>> {
    try {
      const connection = await this.connectionRepository.findById(id, userId);
      if (!connection) throw new ResourceNotFoundException('Email connection not found');
      await this.ingestionRepository.deleteConnectionData(id);
      // Not just accounts this connection's own transactions touched — any of the
      // user's accounts left with zero transactions afterward is orphaned junk,
      // regardless of which connection (or manual entry) originally fed it.
      const accounts = await this.accountService.listAccounts(userId);
      await Promise.all([
        this.budgetRepository.deleteAllForUser(userId),
        this.insightRepository.deleteAllForUser(userId),
        this.accountService.deactivateOrphaned(userId, accounts.map((a) => a.id)),
      ]);
      return { success: true, message: 'Connection data deleted', data: null };
    } catch (error) {
      if (error instanceof ResourceNotFoundException) throw error;
      logger.error(`Error deleting data for connection ${id} - ${error}`);
      throw new InternalServerException('Failed to delete connection data');
    }
  }

  async deleteConnection(id: number, userId: number): Promise<IGeneralResponse<null>> {
    try {
      const connection = await this.connectionRepository.findById(id, userId);
      if (!connection) throw new ResourceNotFoundException('Email connection not found');

      try {
        const accessToken = tokenEncryptionService.decrypt(connection.encryptedAccessToken);
        await fetch(`https://oauth2.googleapis.com/revoke?token=${accessToken}`, {
          method: 'POST',
        });
      } catch {
        logger.warn(`Failed to revoke Google token for connection ${id}`);
      }

      await this.connectionRepository.delete(id, userId);
      return { success: true, message: 'Email connection removed', data: null };
    } catch (error) {
      if (error instanceof ResourceNotFoundException) throw error;
      logger.error(`Error deleting connection ${id} - ${error}`);
      throw new InternalServerException('Failed to delete email connection');
    }
  }

  async addSenderFilterAndResync(userId: number, senderEmail: string): Promise<void> {
    const connections = await this.connectionRepository.findAllByUser(userId);
    const active = connections.filter((c) => c.status === ConnectionStatusEnum.ACTIVE);
    if (active.length === 0) return;

    await Promise.all(
      active.map(async (connection) => {
        try {
          const oauth2Client = await this.getOAuth2Client(connection);
          const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

          const labelId = connection.gmailLabelId;
          if (!labelId) return;

          // Create a from: filter so future emails are auto-labelled
          await gmail.users.settings.filters.create({
            userId: 'me',
            requestBody: {
              criteria: { from: senderEmail },
              action: { addLabelIds: [labelId], removeLabelIds: [] },
            },
          });

          // Backfill existing emails from this sender
          const senderQuery = `from:${senderEmail}`;
          const searchRes = await gmail.users.messages.list({
            userId: 'me',
            q: senderQuery,
            maxResults: BACKFILL_MAX_MESSAGES,
          });
          const messages = searchRes.data.messages;
          if (messages && messages.length > 0) {
            const ids = messages.filter((m) => m.id).map((m) => m.id!);
            await gmail.users.messages.batchModify({
              userId: 'me',
              requestBody: { ids, addLabelIds: [labelId] },
            });
            logger.info(`[EmailConnection] Backfilled ${ids.length} messages from ${senderEmail} for connection ${connection.id}`);
          }

          // Trigger ingestion poll
          setImmediate(async () => {
            try {
              const { container } = require('tsyringe');
              const IngestionService = require('@/modules/ingestion/ingestion.service').default;
              const ingestionService = container.resolve(IngestionService);
              await ingestionService.enqueuePoll(connection.id, 'manual');
            } catch (err) {
              logger.error(`[EmailConnection] Ingestion poll failed for connection ${connection.id}: ${err}`);
            }
          });
        } catch (err) {
          logger.error(`[EmailConnection] addSenderFilterAndResync failed for connection ${connection.id}: ${err}`);
        }
      }),
    );
  }

  async getOAuth2Client(connection: IEmailConnection): Promise<any> {
    const oauth2Client = this.createOAuth2Client();
    const accessToken = tokenEncryptionService.decrypt(connection.encryptedAccessToken);
    const refreshToken = tokenEncryptionService.decrypt(connection.encryptedRefreshToken);

    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
      expiry_date: connection.tokenExpiresAt.getTime(),
    });

    if (connection.tokenExpiresAt < new Date()) {
      try {
        const { credentials } = await oauth2Client.refreshAccessToken();
        const newAccessToken = tokenEncryptionService.encrypt(credentials.access_token!);
        const newExpiry = new Date(credentials.expiry_date || Date.now() + 3600 * 1000);
        await this.connectionRepository.updateTokens(connection.id, newAccessToken, newExpiry);
        oauth2Client.setCredentials(credentials);
      } catch (err: any) {
        const isRevoked =
          err?.message?.includes('invalid_grant') ||
          err?.response?.data?.error === 'invalid_grant';
        if (isRevoked) {
          await this.connectionRepository.updateStatus(
            connection.id,
            ConnectionStatusEnum.REVOKED,
          );
          logger.warn(
            `[Gmail OAuth] invalid_grant for connection ${connection.id} — marked revoked`,
          );
          throw new GmailAuthRevokedError(connection.id);
        }
        throw err;
      }
    }

    return oauth2Client;
  }

  private async findOrCreateLabel(gmail: gmail_v1.Gmail, labelName: string): Promise<string> {
    const listRes = await gmail.users.labels.list({ userId: 'me' });
    const existing = listRes.data.labels?.find(
      (l) => l.name?.toLowerCase() === labelName.toLowerCase(),
    );
    if (existing?.id) return existing.id;

    const createRes = await gmail.users.labels.create({
      userId: 'me',
      requestBody: {
        name: labelName,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
      },
    });

    if (!createRes.data.id) {
      throw new Error(`Failed to create Gmail label "${labelName}"`);
    }

    return createRes.data.id;
  }

  private async createGmailFilter(gmail: gmail_v1.Gmail, labelId: string): Promise<void> {
    const filtersRes = await gmail.users.settings.filters.list({ userId: 'me' });
    const alreadyExists = filtersRes.data.filter?.some(
      (f) => f.action?.addLabelIds?.includes(labelId),
    );
    if (alreadyExists) return;

    await gmail.users.settings.filters.create({
      userId: 'me',
      requestBody: {
        criteria: { query: UNIVERSAL_FILTER_QUERY },
        action: {
          addLabelIds: [labelId],
          removeLabelIds: [],
        },
      },
    });
  }

  private async backfillExistingEmails(
    connectionId: number,
    labelId: string,
    oauth2Client: any,
  ): Promise<void> {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    const searchRes = await gmail.users.messages.list({
      userId: 'me',
      q: UNIVERSAL_FILTER_QUERY,
      maxResults: BACKFILL_MAX_MESSAGES,
    });

    const messages = searchRes.data.messages;
    if (!messages || messages.length === 0) return;

    const ids = messages.filter((m) => m.id).map((m) => m.id!);
    if (ids.length === 0) return;

    await gmail.users.messages.batchModify({
      userId: 'me',
      requestBody: {
        ids,
        addLabelIds: [labelId],
      },
    });

    logger.info(`[EmailConnection] Backfilled ${ids.length} messages for connection ${connectionId}`);
  }

  private createOAuth2Client(redirectUri?: string) {
    return new google.auth.OAuth2(
      CONSTANTS.GOOGLE_WEB_CLIENT_ID,
      CONSTANTS.GOOGLE_CLIENT_SECRET,
      redirectUri || CONSTANTS.GOOGLE_REDIRECT_URI,
    );
  }

  private mapToDTO(c: IEmailConnection): EmailConnectionResponseDTO {
    return {
      id: c.id,
      gmail_address: c.gmailAddress,
      status: c.status,
      gmail_label_id: c.gmailLabelId,
      gmail_label_name: c.gmailLabelName,
      last_synced_at: c.lastSyncedAt,
      created_at: c.createdAt,
      already_connected: false,
    };
  }
}

export default EmailConnectionService;
