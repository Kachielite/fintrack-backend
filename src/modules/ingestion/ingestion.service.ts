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
const NON_TRANSACTION_KEYWORDS = ['otp', 'one time password', 'promotional', 'marketing', 'statement'];

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
  ): Promise<void>;
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
        const alreadyProcessed = await this.ingestionRepository.isAlreadyProcessed(
          connectionId,
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

          await this.processMessage(connectionId, msg.id, body, subject, from);
          processedCount++;
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
  ): Promise<void> {
    try {
      const alreadyProcessed = await this.ingestionRepository.isAlreadyProcessed(
        connectionId,
        messageId,
      );
      if (alreadyProcessed) return;

      const senderEmail = this.extractEmail(fromAddress);
      const bank = await this.bankRepository.findBySenderEmail(senderEmail);

      if (!bank) {
        logger.info(`No bank match for sender ${senderEmail}, messageId=${messageId}`);
        await this.ingestionRepository.markProcessed({
          emailConnectionId: connectionId,
          gmailMessageId: messageId,
          outcome: 'non_transaction',
        });
        return;
      }

      if (!this.looksLikeTransaction(emailBody, emailSubject)) {
        logger.info(`Non-transactional email from ${senderEmail}, messageId=${messageId}`);
        await this.ingestionRepository.markProcessed({
          emailConnectionId: connectionId,
          gmailMessageId: messageId,
          outcome: 'non_transaction',
        });
        return;
      }

      const connection = await this.connectionRepository.findByIdOnly(connectionId);
      const userId = connection?.userId;
      if (!userId) return;

      const user = await this.userRepository.findById(userId);
      if (!user) return;

      const regexResult = await this.parserRuleService.applyTemplate(
        bank.id,
        emailBody,
        emailSubject,
      );

      if (regexResult && Object.keys(regexResult).length > 0) {
        const confidence = CONSTANTS.REGEX_PRODUCTION_THRESHOLD;
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
        return;
      }

      const template = await this.parserRuleService.generateTemplate(
        bank.id,
        emailBody,
        emailSubject,
      );
      const aiResult = await this.parserRuleService.applyTemplate(
        bank.id,
        emailBody,
        emailSubject,
      );

      const refAmount = aiResult?.amount
        ? await this.exchangeRateService.convert(
            Math.abs(aiResult.amount as number),
            (aiResult.currency as string) || user.refCurrency,
            user.refCurrency,
          )
        : 0;

      const exchangeRate = await this.exchangeRateService.getRate(
        (aiResult?.currency as string) || user.refCurrency,
        user.refCurrency,
      );

      const transaction = await this.transactionRepository.create({
        userId,
        emailConnectionId: connectionId,
        bankId: bank.id,
        parserTemplateId: template.id,
        gmailMessageId: messageId,
        merchant: (aiResult?.merchant as string) || 'Unknown',
        category: CategoryEnum.OTHER,
        transactionType:
          (aiResult?.transactionType as TransactionTypeEnum) || TransactionTypeEnum.DEBIT,
        amount: (aiResult?.amount as number) || 0,
        currency: (aiResult?.currency as string) || user.refCurrency,
        refAmount,
        refCurrency: user.refCurrency,
        exchangeRateUsed: exchangeRate,
        transactionDate: new Date(),
        status: TransactionStatusEnum.UNVERIFIED,
        reference: aiResult?.reference as string | undefined,
        balance: aiResult?.balance as number | undefined,
      });

      await this.ingestionRepository.markProcessed({
        emailConnectionId: connectionId,
        gmailMessageId: messageId,
        outcome: 'parsed',
        transactionId: transaction.id,
      });

      setImmediate(() => {
        this.parserRuleService.auditTemplate(template.id).catch((err) => {
          logger.error(`Async audit failed for template ${template.id} - ${err}`);
        });
      });
    } catch (error) {
      logger.error(`Error processing message ${messageId} - ${error}`);
      await this.ingestionRepository.markProcessed({
        emailConnectionId: connectionId,
        gmailMessageId: messageId,
        outcome: 'failed',
      });
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
    if (payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf8');
    }
    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          return Buffer.from(part.body.data, 'base64').toString('utf8');
        }
      }
      for (const part of payload.parts) {
        if (part.mimeType === 'text/html' && part.body?.data) {
          return Buffer.from(part.body.data, 'base64').toString('utf8');
        }
      }
    }
    return '';
  }
}

export default IngestionService;
