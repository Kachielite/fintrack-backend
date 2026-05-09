import { inject, injectable } from 'tsyringe';
import { google } from 'googleapis';
import { CONSTANTS } from '@/common/configuration/constants';
import logger from '@/common/lib/logger';
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
import { TransactionTypeEnum, TransactionStatusEnum, CategoryEnum } from '@/modules/transaction/transaction.enum';

const TRANSACTION_AMOUNT_PATTERN = /\b\d{1,3}(?:,\d{3})*(?:\.\d{2})?\b/;
const NON_TRANSACTION_KEYWORDS = ['otp', 'one time password', 'promotional', 'marketing', 'statement'];

export interface IIngestionService {
  pollAllConnections(): Promise<void>;
  pollConnection(connectionId: number): Promise<void>;
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

  async pollConnection(connectionId: number): Promise<void> {
    try {
      const connection = await this.connectionRepository.findById(connectionId, -1);
      if (!connection) return;

      const connections = await this.connectionRepository.findAllActive();
      const conn = connections.find((c) => c.id === connectionId);
      if (!conn) return;

      if (!conn.gmailLabelId) {
        logger.info(`Connection ${connectionId} has no label set, skipping`);
        return;
      }

      const oauth2Client = await this.emailConnectionService.getOAuth2Client(conn);
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

      const listResp = await gmail.users.messages.list({
        userId: 'me',
        labelIds: [conn.gmailLabelId],
        maxResults: 50,
      });

      const messages = listResp.data.messages || [];
      let processedCount = 0;

      for (const msg of messages) {
        if (!msg.id) continue;
        const alreadyProcessed = await this.ingestionRepository.isAlreadyProcessed(
          connectionId,
          msg.id,
        );
        if (alreadyProcessed) continue;

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
      }

      if (processedCount > 0 || messages.length > 0) {
        await this.connectionRepository.updateLastSynced(connectionId, processedCount);
      }
    } catch (error) {
      logger.error(`Error polling connection ${connectionId} - ${error}`);
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

      const connection = await this.connectionRepository.findAllActive().then((conns) =>
        conns.find((c) => c.id === connectionId),
      );
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
