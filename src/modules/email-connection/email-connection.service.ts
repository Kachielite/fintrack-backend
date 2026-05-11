import { inject, injectable } from 'tsyringe';
import { google } from 'googleapis';
import { CONSTANTS } from '@/common/configuration/constants';
import { tokenEncryptionService } from '@/common/utils/token-encryption';
import {
  InternalServerException,
  ResourceNotFoundException,
} from '@/common/exception';
import logger from '@/common/lib/logger';
import { IEmailConnectionRepository } from './email-connection.repository';
import {
  GmailCallbackDTO,
  SetLabelDTO,
  EmailConnectionResponseDTO,
  GmailLabelDTO,
} from './email-connection.dto';
import { IEmailConnection } from './email-connection.interface';
import { IGeneralResponse } from '@/common/types/interface';

const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const SYSTEM_LABEL_PREFIXES = ['CATEGORY_', 'CHAT', 'SENT', 'INBOX', 'TRASH', 'SPAM', 'DRAFT', 'STARRED', 'IMPORTANT', 'UNREAD'];

export interface IEmailConnectionService {
  getAuthUrl(userId: number): string;
  handleCallback(userId: number, data: GmailCallbackDTO): Promise<EmailConnectionResponseDTO>;
  listConnections(userId: number): Promise<EmailConnectionResponseDTO[]>;
  getConnection(id: number, userId: number): Promise<EmailConnectionResponseDTO>;
  listLabels(id: number, userId: number): Promise<GmailLabelDTO[]>;
  setLabel(id: number, userId: number, data: SetLabelDTO): Promise<EmailConnectionResponseDTO>;
  triggerSync(id: number, userId: number): Promise<IGeneralResponse<null>>;
  deleteConnection(id: number, userId: number): Promise<IGeneralResponse<null>>;
  getOAuth2Client(connection: IEmailConnection): Promise<any>;
}

@injectable()
class EmailConnectionService implements IEmailConnectionService {
  constructor(
    @inject('IEmailConnectionRepository')
    private connectionRepository: IEmailConnectionRepository,
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

      const encryptedAccessToken = tokenEncryptionService.encrypt(tokens.access_token);
      const encryptedRefreshToken = tokenEncryptionService.encrypt(tokens.refresh_token);
      const tokenExpiresAt = new Date(tokens.expiry_date || Date.now() + 3600 * 1000);

      const connection = await this.connectionRepository.create({
        userId,
        gmailAddress,
        encryptedAccessToken,
        encryptedRefreshToken,
        tokenExpiresAt,
      });

      return this.mapToDTO(connection);
    } catch (error) {
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

  async listLabels(id: number, userId: number): Promise<GmailLabelDTO[]> {
    try {
      const connection = await this.connectionRepository.findById(id, userId);
      if (!connection) throw new ResourceNotFoundException('Email connection not found');

      const oauth2Client = await this.getOAuth2Client(connection);
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
      const resp = await gmail.users.labels.list({ userId: 'me' });

      const labels = (resp.data.labels || []).filter((l) => {
        if (!l.id || !l.name) return false;
        return !SYSTEM_LABEL_PREFIXES.some((prefix) => l.id!.startsWith(prefix) || l.name!.startsWith(prefix));
      });

      return labels.map((l) => ({
        id: l.id!,
        name: l.name!,
        messages_total: l.messagesTotal ?? undefined,
      }));
    } catch (error) {
      if (error instanceof ResourceNotFoundException) throw error;
      logger.error(`Error listing Gmail labels for connection ${id} - ${error}`);
      throw new InternalServerException('Failed to list Gmail labels');
    }
  }

  async setLabel(id: number, userId: number, data: SetLabelDTO): Promise<EmailConnectionResponseDTO> {
    try {
      const connection = await this.connectionRepository.findById(id, userId);
      if (!connection) throw new ResourceNotFoundException('Email connection not found');

      const updated = await this.connectionRepository.updateLabel(id, userId, {
        gmailLabelId: data.label_id,
        gmailLabelName: data.label_name,
      });
      return this.mapToDTO(updated);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) throw error;
      logger.error(`Error setting label for connection ${id} - ${error}`);
      throw new InternalServerException('Failed to set Gmail label');
    }
  }

  async triggerSync(id: number, userId: number): Promise<IGeneralResponse<null>> {
    try {
      const connection = await this.connectionRepository.findById(id, userId);
      if (!connection) throw new ResourceNotFoundException('Email connection not found');

      // Fire and forget — resolve ingestionService lazily to avoid circular dep at module load
      setImmediate(() => {
        const { container } = require('tsyringe');
        const IngestionService = require('@/modules/ingestion/ingestion.service').default;
        const ingestionService = container.resolve(IngestionService);
        ingestionService.pollConnection(id, 'manual').catch((err: unknown) => {
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
      const { credentials } = await oauth2Client.refreshAccessToken();
      const newAccessToken = tokenEncryptionService.encrypt(credentials.access_token!);
      const newExpiry = new Date(credentials.expiry_date || Date.now() + 3600 * 1000);
      await this.connectionRepository.updateTokens(connection.id, newAccessToken, newExpiry);
      oauth2Client.setCredentials(credentials);
    }

    return oauth2Client;
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
    };
  }
}

export default EmailConnectionService;
