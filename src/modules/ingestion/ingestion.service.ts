import { inject, injectable } from 'tsyringe';
import { google } from 'googleapis';
import { CONSTANTS } from '@/common/configuration/constants';
import logger from '@/common/lib/logger';
import syncEventBus from '@/common/lib/sync-event-bus';
import { IIngestionRepository } from './ingestion.repository';
import { IEmailConnectionRepository } from '@/modules/email-connection/email-connection.repository';
import { IBankRepository } from '@/modules/bank/bank.repository';
import { IParserRuleService } from '@/modules/parser-rule/parser-rule.service';
import { ITransactionRepository } from '@/modules/transaction/transaction.repository';
import { IExchangeRateService } from '@/modules/exchange-rate/exchange-rate.service';
import { IUserRepository } from '@/modules/user/user.repository';
import EmailConnectionService, {
  IEmailConnectionService,
} from '@/modules/email-connection/email-connection.service';
import ParserRuleService from '@/modules/parser-rule/parser-rule.service';
import NotificationService, { INotificationService } from '@/modules/notification/notification.service';
import { TransactionTypeEnum, TransactionStatusEnum, CategoryEnum } from '@/modules/transaction/transaction.enum';

const TRANSACTION_AMOUNT_PATTERN = /\b\d{1,3}(?:,\d{3})*(?:\.\d{2})?\b/;
const NON_TRANSACTION_KEYWORDS = [
  'otp', 'one time password', 'promotional', 'marketing', 'statement',
  'how did you feel', 'how was your experience', 'rate your experience',
  'customer satisfaction', 'satisfaction survey', 'kindly rate', 'share your feedback',
  'how do you rate', 'unsubscribe', 'privacy policy',
];

type TriggerSource = 'cron' | 'manual';

export interface IIngestionService {
  pollAllConnections(): Promise<void>;
  pollConnection(connectionId: number, source?: TriggerSource): Promise<void>;
  processMessage(
    connectionId: number,
    messageId: string,
    emailBody: string,
    emailSubject: string,
    fromAddress: string,
  ): Promise<boolean>;
}

@injectable()
class IngestionService implements IIngestionService {
  constructor(
    @inject('IIngestionRepository') private ingestionRepository: IIngestionRepository,
    @inject('IEmailConnectionRepository')
    private connectionRepository: IEmailConnectionRepository,
    @inject('IBankRepository') private bankRepository: IBankRepository,
    @inject(ParserRuleService) private parserRuleService: IParserRuleService,
    @inject('ITransactionRepository') private transactionRepository: ITransactionRepository,
    @inject('IExchangeRateService') private exchangeRateService: IExchangeRateService,
    @inject('IUserRepository') private userRepository: IUserRepository,
    @inject(EmailConnectionService)
    private emailConnectionService: IEmailConnectionService,
    @inject(NotificationService) private notificationService: INotificationService,
  ) {}

  async pollAllConnections(): Promise<void> {
    try {
      const connections = await this.connectionRepository.findAllActive();
      logger.info(`Polling ${connections.length} active email connections`);
      await Promise.all(connections.map((c) => this.pollConnection(c.id)));
    } catch (error) {
      logger.error(`Error in pollAllConnections - ${error}`);
    }
  }

  async pollConnection(connectionId: number, source: TriggerSource = 'cron'): Promise<void> {
    const channel = `sync:${connectionId}`;
    const emit = (event: string, data: unknown) =>
      syncEventBus.emit(channel, { event, data });

    try {
      emit('connecting', {});
      logger.info(`[Ingestion] Starting poll for connection ${connectionId} (source: ${source})`);

      const connection = await this.connectionRepository.findByIdOnly(connectionId);
      if (!connection) {
        logger.warn(`[Ingestion] Connection ${connectionId} not found, aborting`);
        emit('error', { message: 'Connection not found' });
        return;
      }

      if (!connection.gmailLabelId) {
        logger.info(`[Ingestion] Connection ${connectionId} has no label set, skipping`);
        emit('error', { message: 'No Gmail label configured' });
        return;
      }

      const labelName = connection.gmailLabelName ?? 'Bank Transactions';
      emit('searching', { labelName });
      logger.info(`[Ingestion] Searching Gmail label "${labelName}" for connection ${connectionId}`);

      const oauth2Client = await this.emailConnectionService.getOAuth2Client(connection);
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

      const listResp = await gmail.users.messages.list({
        userId: 'me',
        labelIds: [connection.gmailLabelId],
        maxResults: 50,
      });

      const messages = listResp.data.messages || [];
      const total = messages.length;
      logger.info(`[Ingestion] Found ${total} messages in label "${labelName}" for connection ${connectionId}`);

      emit('start', { total });

      let processedCount = 0;
      let doneIndex = 0;

      for (const msg of messages) {
        if (!msg.id) continue;
        const alreadyProcessed = await this.ingestionRepository.isAlreadyProcessedForUser(
          connection.userId,
          msg.id,
        );
        doneIndex++;

        if (alreadyProcessed) {
          emit('progress', { processed: doneIndex, total });
          continue;
        }

        try {
          const msgResp = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id,
            format: 'full',
          });

          const headers = msgResp.data.payload?.headers || [];
          const fromHeader = headers.find((h) => h.name?.toLowerCase() === 'from');
          const subjectHeader = headers.find((h) => h.name?.toLowerCase() === 'subject');
          const from = fromHeader?.value || '';
          const subject = subjectHeader?.value || '';
          const body = this.extractEmailBody(msgResp.data.payload);

          const wasTransaction = await this.processMessage(connectionId, msg.id, body, subject, from);
          if (wasTransaction) processedCount++;
        } catch (err) {
          logger.error(
            `Error processing message ${msg.id} for connection ${connectionId} - ${err}`,
          );
          await this.ingestionRepository.markProcessed({
            emailConnectionId: connectionId,
            gmailMessageId: msg.id,
            outcome: 'failed',
          });
        }

        emit('progress', { processed: doneIndex, total });
      }

      if (processedCount > 0 || messages.length > 0) {
        await this.connectionRepository.updateLastSynced(connectionId, processedCount);
      }

      logger.info(`[Ingestion] Poll complete for connection ${connectionId}: ${processedCount} new transactions from ${total} messages`);
      emit('done', { added: processedCount });

      // Create a notification — always for manual/SSE, only when new transactions for cron
      const userId = connection.userId;
      if (source === 'manual' || processedCount > 0) {
        await this.notificationService.create({
          userId,
          type: 'sync_complete',
          title: processedCount > 0 ? 'Sync complete' : 'Sync complete — nothing new',
          body:
            processedCount > 0
              ? `${processedCount} new transaction${processedCount !== 1 ? 's' : ''} organised from your Gmail`
              : 'No new bank emails were found in your label.',
          data: { added: processedCount, connectionId },
        });
      }
    } catch (error) {
      logger.error(`[Ingestion] Error polling connection ${connectionId} - ${error}`);
      emit('error', { message: 'Sync failed unexpectedly' });

      if (source === 'manual') {
        try {
          const conn = await this.connectionRepository.findByIdOnly(connectionId);
          if (conn?.userId) {
            await this.notificationService.create({
              userId: conn.userId,
              type: 'sync_failed',
              title: 'Sync failed',
              body: 'Something went wrong while reading your Gmail. Please try again.',
              data: { connectionId },
            });
          }
        } catch {
          // ignore notification failure
        }
      }
    }
  }

  async processMessage(
    connectionId: number,
    messageId: string,
    emailBody: string,
    emailSubject: string,
    fromAddress: string,
  ): Promise<boolean> {
    try {
      const connection = await this.connectionRepository.findByIdOnly(connectionId);
      const userId = connection?.userId;
      if (!userId) return false;

      const alreadyProcessed = await this.ingestionRepository.isAlreadyProcessedForUser(
        userId,
        messageId,
      );
      if (alreadyProcessed) return false;

      const senderEmail = this.extractEmail(fromAddress);
      let bank = await this.bankRepository.findBySenderEmail(senderEmail);

      if (!bank) {
        if (!this.looksLikeTransaction(emailBody, emailSubject)) {
          logger.info(`Non-transactional email from unknown sender ${senderEmail}, messageId=${messageId}`);
          await this.ingestionRepository.markProcessed({
            emailConnectionId: connectionId,
            gmailMessageId: messageId,
            outcome: 'non_transaction',
          });
          return false;
        }

        logger.info(`Unknown sender ${senderEmail} — asking AI to identify bank, messageId=${messageId}`);
        const identified = await this.parserRuleService.identifyBank(senderEmail, emailSubject, emailBody);
        if (!identified) {
          logger.info(`AI: not a bank email from ${senderEmail}, messageId=${messageId}`);
          await this.ingestionRepository.markProcessed({
            emailConnectionId: connectionId,
            gmailMessageId: messageId,
            outcome: 'non_transaction',
          });
          return false;
        }

        logger.info(`AI identified bank "${identified.name}" from ${senderEmail} — registering`);
        bank = await this.bankRepository.upsertByShortCode({
          name: identified.name,
          shortCode: identified.shortCode,
          country: identified.country,
          senderEmail,
        });
      }

      if (!this.looksLikeTransaction(emailBody, emailSubject)) {
        logger.info(`Non-transactional email from ${senderEmail}, messageId=${messageId}`);
        await this.ingestionRepository.markProcessed({
          emailConnectionId: connectionId,
          gmailMessageId: messageId,
          outcome: 'non_transaction',
        });
        return false;
      }

      const user = await this.userRepository.findById(userId);
      if (!user) return false;

      const regexResult = await this.parserRuleService.applyTemplate(
        bank.id,
        emailBody,
        emailSubject,
      );

      if (regexResult && Object.keys(regexResult).length > 0) {
        const refAmount = regexResult.amount
          ? await this.exchangeRateService.convert(
              Math.abs(regexResult.amount as number),
              (regexResult.currency as string) || user.refCurrency,
              user.refCurrency,
            )
          : 0;

        const exchangeRate = await this.exchangeRateService.getRate(
          (regexResult.currency as string) || user.refCurrency,
          user.refCurrency,
        );

        const transaction = await this.transactionRepository.create({
          userId,
          emailConnectionId: connectionId,
          bankId: bank.id,
          gmailMessageId: messageId,
          merchant: (regexResult.merchant as string) || 'Unknown',
          category: CategoryEnum.OTHER,
          transactionType:
            (regexResult.transactionType as TransactionTypeEnum) || TransactionTypeEnum.DEBIT,
          amount: (regexResult.amount as number) || 0,
          currency: (regexResult.currency as string) || user.refCurrency,
          refAmount,
          refCurrency: user.refCurrency,
          exchangeRateUsed: exchangeRate,
          transactionDate: new Date(),
          status: TransactionStatusEnum.VERIFIED,
          reference: regexResult.reference as string | undefined,
          balance: regexResult.balance as number | undefined,
        });

        await this.ingestionRepository.markProcessed({
          emailConnectionId: connectionId,
          gmailMessageId: messageId,
          outcome: 'parsed',
          transactionId: transaction.id,
        });
        return true;
      }

      // No production regex template yet — extract directly with AI
      const extracted = await this.parserRuleService.extractTransaction(
        bank.name,
        emailBody,
        emailSubject,
      );

      if (!extracted) {
        logger.info(`AI extraction returned non-transaction for ${bank.name}, messageId=${messageId}`);
        await this.ingestionRepository.markProcessed({
          emailConnectionId: connectionId,
          gmailMessageId: messageId,
          outcome: 'non_transaction',
        });
        return false;
      }

      const extractedCurrency = (extracted.currency as string) || user.refCurrency;
      const refAmount = extracted.amount
        ? await this.exchangeRateService.convert(
            Math.abs(extracted.amount as number),
            extractedCurrency,
            user.refCurrency,
          )
        : 0;

      const exchangeRate = await this.exchangeRateService.getRate(extractedCurrency, user.refCurrency);

      const extractedDate = extracted.date ? new Date(extracted.date) : null;
      const transaction = await this.transactionRepository.create({
        userId,
        emailConnectionId: connectionId,
        bankId: bank.id,
        gmailMessageId: messageId,
        merchant: (extracted.merchant as string) || 'Unknown',
        category: (extracted.category as CategoryEnum) || CategoryEnum.OTHER,
        transactionType:
          (extracted.transactionType as TransactionTypeEnum) || TransactionTypeEnum.DEBIT,
        amount: (extracted.amount as number) || 0,
        currency: extractedCurrency,
        refAmount,
        refCurrency: user.refCurrency,
        exchangeRateUsed: exchangeRate,
        transactionDate: extractedDate && !isNaN(extractedDate.getTime()) ? extractedDate : new Date(),
        status: TransactionStatusEnum.UNVERIFIED,
        reference: extracted.reference as string | undefined,
        balance: extracted.balance as number | undefined,
      });

      await this.ingestionRepository.markProcessed({
        emailConnectionId: connectionId,
        gmailMessageId: messageId,
        outcome: 'parsed',
        transactionId: transaction.id,
      });

      // Build regex template in background so future emails use fast regex path
      setImmediate(() => {
        this.parserRuleService
          .generateTemplate(bank.id, emailBody, emailSubject)
          .then((template) => this.parserRuleService.auditTemplate(template.id))
          .catch((err) => logger.error(`Background template generation failed for bank ${bank.id} - ${err}`));
      });

      return true;
    } catch (error) {
      logger.error(`Error processing message ${messageId} - ${error}`);
      await this.ingestionRepository.markProcessed({
        emailConnectionId: connectionId,
        gmailMessageId: messageId,
        outcome: 'failed',
      });
      return false;
    }
  }

  private looksLikeTransaction(body: string, subject: string): boolean {
    const combined = `${subject} ${body}`.toLowerCase();
    if (NON_TRANSACTION_KEYWORDS.some((kw) => combined.includes(kw))) return false;
    return TRANSACTION_AMOUNT_PATTERN.test(body);
  }

  private extractEmail(from: string): string {
    const match = from.match(/<(.+)>/);
    return (match ? match[1] : from).toLowerCase().trim();
  }

  private extractEmailBody(payload: any): string {
    if (!payload) return '';
    // Try text/plain first (recursively through nested multipart)
    const plain = this.findMimePart(payload, 'text/plain');
    if (plain) return plain;
    // Fall back to HTML, stripped to readable text
    const html = this.findMimePart(payload, 'text/html');
    if (html) return this.stripHtml(html);
    return '';
  }

  private findMimePart(payload: any, mimeType: string): string {
    if (!payload) return '';
    if (payload.mimeType === mimeType && payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf8');
    }
    if (payload.parts) {
      for (const part of payload.parts) {
        const result = this.findMimePart(part, mimeType);
        if (result) return result;
      }
    }
    return '';
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
}

export default IngestionService;
