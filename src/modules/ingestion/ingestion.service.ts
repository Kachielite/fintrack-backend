import { inject, injectable } from 'tsyringe';
import { google } from 'googleapis';
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

const TRANSACTION_AMOUNT_PATTERN = /\b\d+(?:,\d{3})*(?:\.\d{1,2})?\b/;
const CURRENCY_PATTERN = /\b(ngn|usd|kes|gbp|eur|zar|ghs)\b|[₦$£€]/i;
const TRANSACTION_HINT_KEYWORDS = [
  'debit', 'credited', 'credit', 'withdraw', 'withdrawal', 'transfer', 'pos', 'purchase',
  'payment', 'transaction', 'trx', 'alert', 'spent', 'received', 'successful', 'reversal',
  'balance', 'transaction notification', 'debit alert details', 'value date', 'time of transaction',
];
const NON_TRANSACTION_KEYWORDS = [
  'otp', 'one time password', 'promotional', 'marketing', 'e-statement', 'account statement',
  'how did you feel', 'how was your experience', 'rate your experience',
  'customer satisfaction', 'satisfaction survey', 'kindly rate', 'share your feedback',
  'how do you rate', 'unsubscribe', 'privacy policy',
];

const CATEGORY_REGEX_RULES: Array<{ category: CategoryEnum; pattern: RegExp }> = [
  { category: CategoryEnum.BUSINESS_PAYMENT, pattern: /(POS|WEB|PAYMENT|STORE|MERCHANT|SHOP|ONLINE)\s+[@A-Z0-9_-]+/i },
  { category: CategoryEnum.SUBSCRIPTIONS, pattern: /(SPOTIFY|NETFLIX|APPLE|MICROSOFT|GOOGLE|YOUTUBE|DISNEY|SUBSCRIPTION|PLAN|PREMIUM|JETBRAINS|GITHUB)/i },
  { category: CategoryEnum.ENTERTAINMENT_LEISURE, pattern: /(MOVIE|CINEMA|CLUB|TICKET|EVENT|GAME|PLAYSTATION|STEAM)/i },
  { category: CategoryEnum.MOBILE_INTERNET, pattern: /(MTN|AIRTEL|GLO|9MOBILE|VODAFONE|SAFARICOM|TELKOM|RECHARGE|DATA|TOP\s?UP|BUNDLE)/i },
  { category: CategoryEnum.UTILITIES, pattern: /(ELECTRIC|POWER|UTILITY|WATER|GAS|BILL|NEPA|KES|KPLC)/i },
  { category: CategoryEnum.GROCERIES, pattern: /(SUPERMARKET|GROCERY|SHOPRITE|MARKET|DELIVERY|FOODCO|SUPERMART|GLOVO)/i },
  { category: CategoryEnum.RETAIL_ECOMMERCE, pattern: /(JUMIA|AMAZON|ALIEXPRESS|SHEIN|EBAY|SHOP|STORE|BOUTIQUE|FASHION)/i },
  { category: CategoryEnum.DINING_FOOD_DELIVERY, pattern: /(EAT|CAFE|FOOD|RESTAURANT|DELIVERY|UBER\s?EATS|JUMIA\s?FOOD|DOORDASH|GLOVO)/i },
  { category: CategoryEnum.TRANSPORT, pattern: /(UBER|BOLT|TAXI|BUS|TRAIN|FARE|RIDE)/i },
  { category: CategoryEnum.FUEL_AUTO, pattern: /(FILLING\s?STATION|FUEL|PETROL|OIL|AUTO|CAR|SERVICE|LUBRICANT|MECHANIC)/i },
  { category: CategoryEnum.TRAVEL, pattern: /(FLIGHT|AIRWAYS|HOTEL|BOOKING|AGENCY|TRIP|VACATION|TRAVEL)/i },
  { category: CategoryEnum.BANK_CHARGES, pattern: /(CHARGE|FEE|MAINTENANCE|ATM\s?FEE|VAT|BANK\s?FEE)/i },
  { category: CategoryEnum.CURRENCY_CONVERSION, pattern: /(FX|FOREX|CONVERSION|USD|GBP|EUR|EXCHANGE)/i },
  { category: CategoryEnum.SALARY_WAGES, pattern: /(SALARY|PAYROLL|WAGES|HRPAY|INCOME|PAYMENT\s?FROM|COMPENSATION|TAPPI)/i },
  { category: CategoryEnum.REFUNDS_REIMBURSEMENTS, pattern: /(REFUND|REVERSAL|CASHBACK|REV|REIMBURSE)/i },
  { category: CategoryEnum.HEALTHCARE, pattern: /(HOSPITAL|PHARMACY|MEDICAL|CLINIC|HEALTH|INSURANCE|NHIS)/i },
  { category: CategoryEnum.EDUCATION, pattern: /(SCHOOL|TUITION|COURSE|EDU|ACADEMY|E-LEARNING|TRAINING|BOOK)/i },
  { category: CategoryEnum.CHARITY_DONATIONS, pattern: /(CHURCH|MOSQUE|CHARITY|DONATION|TITHE|FOUNDATION|NGO)/i },
  { category: CategoryEnum.CASH_WITHDRAWAL, pattern: /(ATM|CASH\s?WITHDRAWAL|BRANCH)/i },
  { category: CategoryEnum.PEER_TO_PEER_TRANSFER, pattern: /(IFO|TRANSFER|P2P|SEND|TO|TRF\/\/FRM|BENEFICIARY|MOBILE\s?MONEY|PERSONAL\s?TRANSFER|PAYMENT\s?TO|[A-Z]{2,}\s+[A-Z]{2,}(\s+[A-Z]{2,})?|PAMELA|IRENE|JOEL|SHELLA)/i },
];

type TriggerSource = 'cron' | 'manual';
const TEMPLATE_RETRY_COOLDOWN_MS = 2 * 60 * 1000;

interface TransactionSignal {
  isTransaction: boolean;
  reason: string;
}

interface CategoryResolution {
  category: CategoryEnum;
  source: 'learned' | 'regex_rule' | 'extracted' | 'default_uncategorized';
  matchedRule?: string;
}

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
  private templateGenerationInFlight = new Set<number>();
  private templateGenerationCooldownUntil = new Map<number, number>();

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
      const transactionSignal = this.getTransactionSignal(emailBody, emailSubject);
      let bank = await this.bankRepository.findBySenderEmail(senderEmail);

      if (!bank) {
        if (!transactionSignal.isTransaction) {
          logger.info(
            `Non-transactional email from unknown sender ${senderEmail}, messageId=${messageId}, reason=${transactionSignal.reason}`,
          );
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

      if (!transactionSignal.isTransaction && !bank) {
        logger.info(
          `Non-transactional email from ${senderEmail}, messageId=${messageId}, reason=${transactionSignal.reason}`,
        );
        await this.ingestionRepository.markProcessed({
          emailConnectionId: connectionId,
          gmailMessageId: messageId,
          outcome: 'non_transaction',
        });
        return false;
      }

      const user = await this.userRepository.findById(userId);
      if (!user) return false;

      const templateResult = await this.parserRuleService.applyTemplate(
        bank.id,
        emailBody,
        emailSubject,
      );

      if (templateResult && Object.keys(templateResult.parsed).length > 0) {
        const regexResult = templateResult.parsed;
        const normalizedType = this.normalizeTransactionType(regexResult.transactionType);
        const parsedAmount = Number(regexResult.amount ?? 0);
        const signedAmount = this.toSignedAmount(parsedAmount, normalizedType);
        const transactionDate = this.parseTransactionDate(regexResult.date);
        const merchant = (regexResult.merchant as string) || 'Unknown';
        const currency = (regexResult.currency as string) || user.refCurrency;
        const learnedCategory = await this.transactionRepository.findLearnedCategoryForMerchant(
          userId,
          merchant,
        );
        const categoryResolution = this.resolveCategory(
          merchant,
          emailSubject,
          emailBody,
          regexResult.category as string | undefined,
          learnedCategory,
        );
        const category = categoryResolution.category;
        const reference = regexResult.reference as string | undefined;

        const isDuplicate = await this.transactionRepository.existsSimilarTransaction({
          userId,
          bankId: bank.id,
          currency,
          amountAbs: Math.abs(signedAmount),
          reference,
          merchant,
          transactionDate,
        });
        if (isDuplicate) {
          logger.info(`Duplicate transaction skipped for messageId=${messageId}`);
          await this.ingestionRepository.markProcessed({
            emailConnectionId: connectionId,
            gmailMessageId: messageId,
            outcome: 'parsed',
          });
          return false;
        }

        const refAmount = parsedAmount
          ? await this.exchangeRateService.convert(
              Math.abs(parsedAmount),
              currency,
              user.refCurrency,
            )
          : 0;

        const exchangeRate = await this.exchangeRateService.getRate(
          currency,
          user.refCurrency,
        );

        const transaction = await this.transactionRepository.create({
          userId,
          emailConnectionId: connectionId,
          bankId: bank.id,
          parserTemplateId: templateResult.templateId,
          gmailMessageId: messageId,
          merchant,
          category,
          transactionType: normalizedType,
          amount: signedAmount,
          currency,
          refAmount,
          refCurrency: user.refCurrency,
          exchangeRateUsed: exchangeRate,
          transactionDate,
          status: TransactionStatusEnum.UNVERIFIED,
          reference,
          balance: regexResult.balance as number | undefined,
        });

        setImmediate(() => {
          this.parserRuleService.recordMatch(templateResult.templateId).catch((err) => {
            logger.error(`Failed to record regex match for template ${templateResult.templateId} - ${err}`);
          });
        });

        await this.ingestionRepository.markProcessed({
          emailConnectionId: connectionId,
          gmailMessageId: messageId,
          outcome: 'parsed',
          transactionId: transaction.id,
        });
        logger.info(
          `Category resolved for messageId=${messageId}: category=${category}, source=${categoryResolution.source}${categoryResolution.matchedRule ? `, rule=${categoryResolution.matchedRule}` : ''}`,
        );
        return true;
      }

      // No production regex template yet — extract directly with AI
      const extracted = await this.parserRuleService.extractTransaction(
        bank.name,
        emailBody,
        emailSubject,
      );

      const extractedOrFallback = extracted || this.extractStructuredFallback(emailBody, emailSubject);

      if (!extractedOrFallback) {
        logger.info(`AI extraction returned non-transaction for ${bank.name}, messageId=${messageId}`);
        await this.ingestionRepository.markProcessed({
          emailConnectionId: connectionId,
          gmailMessageId: messageId,
          outcome: 'non_transaction',
        });
        return false;
      }

      const extractedCurrency = (extractedOrFallback.currency as string) || user.refCurrency;
      const normalizedType = this.normalizeTransactionType(extractedOrFallback.transactionType);
      const parsedAmount = Number(extractedOrFallback.amount ?? 0);
      const signedAmount = this.toSignedAmount(parsedAmount, normalizedType);
      const merchant = (extractedOrFallback.merchant as string) || 'Unknown';
      const extractedDate = this.parseTransactionDate(extractedOrFallback.date);
      const learnedCategory = await this.transactionRepository.findLearnedCategoryForMerchant(
        userId,
        merchant,
      );
      const categoryResolution = this.resolveCategory(
        merchant,
        emailSubject,
        emailBody,
        extractedOrFallback.category as string | undefined,
        learnedCategory,
      );
      const category = categoryResolution.category;
      const reference = extractedOrFallback.reference as string | undefined;

      const isDuplicate = await this.transactionRepository.existsSimilarTransaction({
        userId,
        bankId: bank.id,
        currency: extractedCurrency,
        amountAbs: Math.abs(signedAmount),
        reference,
        merchant,
        transactionDate: extractedDate,
      });
      if (isDuplicate) {
        logger.info(`Duplicate transaction skipped for messageId=${messageId}`);
        await this.ingestionRepository.markProcessed({
          emailConnectionId: connectionId,
          gmailMessageId: messageId,
          outcome: 'parsed',
        });
        return false;
      }

      const refAmount = parsedAmount
        ? await this.exchangeRateService.convert(
            Math.abs(parsedAmount),
            extractedCurrency,
            user.refCurrency,
          )
        : 0;

      const exchangeRate = await this.exchangeRateService.getRate(extractedCurrency, user.refCurrency);

      const transaction = await this.transactionRepository.create({
        userId,
        emailConnectionId: connectionId,
        bankId: bank.id,
        gmailMessageId: messageId,
        merchant,
        category,
        transactionType: normalizedType,
        amount: signedAmount,
        currency: extractedCurrency,
        refAmount,
        refCurrency: user.refCurrency,
        exchangeRateUsed: exchangeRate,
        transactionDate: extractedDate,
        status: TransactionStatusEnum.UNVERIFIED,
        reference,
        balance: extractedOrFallback.balance as number | undefined,
      });

      await this.ingestionRepository.markProcessed({
        emailConnectionId: connectionId,
        gmailMessageId: messageId,
        outcome: 'parsed',
        transactionId: transaction.id,
      });
      logger.info(
        `Category resolved for messageId=${messageId}: category=${category}, source=${categoryResolution.source}${categoryResolution.matchedRule ? `, rule=${categoryResolution.matchedRule}` : ''}`,
      );

      // Build regex template in background so future emails use fast regex path.
      this.scheduleTemplateGeneration(bank.id, emailBody, emailSubject);

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

  private getTransactionSignal(body: string, subject: string): TransactionSignal {
    const combined = `${subject} ${body}`.toLowerCase();
    const hasNonTransactionKeyword = NON_TRANSACTION_KEYWORDS.some((kw) => combined.includes(kw));
    const hasAmount = TRANSACTION_AMOUNT_PATTERN.test(combined);
    const hasCurrency = CURRENCY_PATTERN.test(combined);
    const hasHintKeyword = TRANSACTION_HINT_KEYWORDS.some((kw) => combined.includes(kw));

    // Only suppress when the content looks purely non-transactional.
    if (hasNonTransactionKeyword && !(hasAmount || hasCurrency || hasHintKeyword)) {
      return { isTransaction: false, reason: 'non_transaction_keywords_only' };
    }
    if (hasHintKeyword && (hasAmount || hasCurrency)) {
      return { isTransaction: true, reason: 'hint_and_numeric_or_currency_signal' };
    }
    if (hasAmount && hasCurrency) {
      return { isTransaction: true, reason: 'amount_and_currency_signal' };
    }
    return { isTransaction: false, reason: 'insufficient_transaction_signals' };
  }

  private extractStructuredFallback(
    body: string,
    subject: string,
  ): {
    amount?: number;
    currency?: string;
    merchant?: string;
    category?: string;
    transactionType?: string;
    date?: string;
    balance?: number;
    reference?: string;
  } | null {
    const combined = `${subject}\n${body}`;

    const amountMatch = combined.match(/amount\s*[:\n ]\s*(?:([A-Z]{3})|[₦$£€])?\s*([\d,]+(?:\.\d{1,2})?)/i);
    if (!amountMatch) return null;

    const balanceMatch = combined.match(/(?:current|available)?\s*balance\s*[:\n ]\s*(?:([A-Z]{3})|[₦$£€])?\s*([\d,]+(?:\.\d{1,2})?)/i);
    const referenceMatch = combined.match(/(?:transaction\s+reference|document\s+number|reference)\s*[:\n ]\s*([^\n]+)/i);
    const descriptionMatch = combined.match(/description\s*[:\n ]\s*([^\n]+)/i);
    const dateMatch = combined.match(/(?:transaction\s+date\s*&\s*time|value\s+date|time\s+of\s+transaction)\s*[:\n ]\s*([^\n]+)/i);

    const typeMatch = combined.match(/\b(debit|credit)\b/i);
    const parsedAmount = parseFloat((amountMatch[2] || '').replace(/,/g, ''));
    if (!isFinite(parsedAmount)) return null;

    return {
      amount: parsedAmount,
      currency: amountMatch[1] || balanceMatch?.[1] || undefined,
      merchant: (descriptionMatch?.[1] || '').trim() || 'Unknown',
      transactionType: (typeMatch?.[1] || '').toLowerCase() || TransactionTypeEnum.DEBIT,
      date: this.normalizeDateString(dateMatch?.[1]),
      balance: balanceMatch?.[2]
        ? parseFloat(balanceMatch[2].replace(/,/g, ''))
        : undefined,
      reference: referenceMatch?.[1]?.trim() || undefined,
    };
  }

  private normalizeDateString(input?: string): string | undefined {
    if (!input) return undefined;
    const cleaned = input.replace(/\./g, '').trim();
    const parsed = new Date(cleaned);
    if (isNaN(parsed.getTime())) return undefined;
    return parsed.toISOString();
  }

  private normalizeTransactionType(value: string | undefined): TransactionTypeEnum {
    const normalized = (value || '').toLowerCase();
    return normalized === TransactionTypeEnum.CREDIT
      ? TransactionTypeEnum.CREDIT
      : TransactionTypeEnum.DEBIT;
  }

  private toSignedAmount(amount: number, transactionType: TransactionTypeEnum): number {
    if (!isFinite(amount) || amount === 0) return 0;
    const absAmount = Math.abs(amount);
    return transactionType === TransactionTypeEnum.DEBIT ? -absAmount : absAmount;
  }

  private parseTransactionDate(value: string | undefined): Date {
    if (!value) return new Date();
    const parsed = new Date(value);
    return isNaN(parsed.getTime()) ? new Date() : parsed;
  }

  private resolveCategory(
    merchant: string,
    subject: string,
    body: string,
    extractedCategory?: string,
    learnedCategory?: CategoryEnum | null,
  ): CategoryResolution {
    if (learnedCategory) {
      return {
        category: learnedCategory,
        source: 'learned',
      };
    }

    const normalized = `${merchant} ${subject} ${body}`.toLowerCase();
    for (const rule of CATEGORY_REGEX_RULES) {
      if (rule.pattern.test(normalized)) {
        return {
          category: rule.category,
          source: 'regex_rule',
          matchedRule: rule.pattern.source,
        };
      }
    }

    if (extractedCategory) {
      const maybeCategory = extractedCategory.toLowerCase();
      if (Object.values(CategoryEnum).includes(maybeCategory as CategoryEnum)) {
        return {
          category: maybeCategory as CategoryEnum,
          source: 'extracted',
        };
      }
    }

    return {
      category: CategoryEnum.UNCATEGORIZED,
      source: 'default_uncategorized',
    };
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

  private scheduleTemplateGeneration(bankId: number, emailBody: string, emailSubject: string): void {
    const now = Date.now();
    const cooldownUntil = this.templateGenerationCooldownUntil.get(bankId) || 0;
    if (this.templateGenerationInFlight.has(bankId) || cooldownUntil > now) {
      return;
    }

    this.templateGenerationInFlight.add(bankId);
    setImmediate(() => {
      this.parserRuleService
        .generateTemplate(bankId, emailBody, emailSubject)
        .then((template) => this.parserRuleService.auditTemplate(template.id))
        .then(() => {
          this.templateGenerationCooldownUntil.delete(bankId);
        })
        .catch((err) => {
          if (this.isRateLimitError(err)) {
            this.templateGenerationCooldownUntil.set(bankId, Date.now() + TEMPLATE_RETRY_COOLDOWN_MS);
            logger.warn(
              `Template generation rate-limited for bank ${bankId}; pausing retries for ${TEMPLATE_RETRY_COOLDOWN_MS / 1000}s`,
            );
            return;
          }
          logger.error(`Background template generation failed for bank ${bankId} - ${err}`);
        })
        .finally(() => {
          this.templateGenerationInFlight.delete(bankId);
        });
    });
  }

  private isRateLimitError(error: unknown): boolean {
    const e = error as { status?: number; message?: string };
    return e?.status === 429 || (e?.message || '').includes('429');
  }
}

export default IngestionService;
