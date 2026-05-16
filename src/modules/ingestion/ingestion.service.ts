import { inject, injectable } from 'tsyringe';
import { google } from 'googleapis';
import logger from '@/common/lib/logger';
import syncEventBus from '@/common/lib/sync-event-bus';
import { IIngestionRepository } from './ingestion.repository';
import { IEmailConnectionRepository } from '@/modules/email-connection/email-connection.repository';
import { IBankRepository } from '@/modules/bank/bank.repository';
import { IParserRuleService, IdentifiedBank } from '@/modules/parser-rule/parser-rule.service';
import { ITransactionRepository } from '@/modules/transaction/transaction.repository';
import { IExchangeRateService } from '@/modules/exchange-rate/exchange-rate.service';
import { IUserRepository } from '@/modules/user/user.repository';
import EmailConnectionService, {
  IEmailConnectionService,
} from '@/modules/email-connection/email-connection.service';
import ParserRuleService from '@/modules/parser-rule/parser-rule.service';
import NotificationService, { INotificationService } from '@/modules/notification/notification.service';
import { TransactionTypeEnum, TransactionStatusEnum, CategoryEnum } from '@/modules/transaction/transaction.enum';
import { ICategoryRepository } from '@/modules/category/category.repository';
import { ICategory } from '@/modules/category/category.interface';
import { IBank } from '@/modules/bank/bank.interface';

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

type TriggerSource = 'cron' | 'manual';
const TEMPLATE_RETRY_COOLDOWN_MS = 2 * 60 * 1000;
const CATEGORY_CACHE_TTL_MS = 5 * 60 * 1000;

interface TransactionSignal {
  isTransaction: boolean;
  reason: string;
}

interface CategoryResolution {
  category: string;
  source: 'learned' | 'regex_rule' | 'extracted' | 'default_uncategorized';
  matchedRule?: string;
  verified: boolean;
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
  private categoryCache: { categories: ICategory[]; expiresAt: number } | null = null;

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
    @inject('ICategoryRepository') private categoryRepository: ICategoryRepository,
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
      const bankMatch = await this.bankRepository.findBySenderEmail(senderEmail);
      let bank = bankMatch?.bank ?? null;
      const domainHintBank = bank ? null : await this.findBankByDomainHint(senderEmail);

      if (bankMatch) {
        logger.info(
          `[Bank] ${bankMatch.source}: matched "${bank!.name}" from ${senderEmail}, messageId=${messageId}`,
        );
      }

      if (!bank && domainHintBank) {
        bank = domainHintBank;
        logger.info(
          `[Bank] domain_name_hint: matched "${bank.name}" from ${senderEmail}, messageId=${messageId}`,
        );
      }

      if (!bank) {
        if (!transactionSignal.isTransaction) {
          logger.info(
            `[Bank] Non-transactional email from unknown sender ${senderEmail}, messageId=${messageId}, reason=${transactionSignal.reason}`,
          );
          await this.ingestionRepository.markProcessed({
            emailConnectionId: connectionId,
            gmailMessageId: messageId,
            outcome: 'non_transaction',
          });
          return false;
        }

        logger.info(`[Bank] Unknown sender ${senderEmail} — asking AI to identify bank, messageId=${messageId}`);
        let identified: IdentifiedBank | null = null;
        try {
          identified = await this.parserRuleService.identifyBank(senderEmail, emailSubject, emailBody);
        } catch (err) {
          if (this.isRateLimitError(err)) {
            logger.warn(
              `[Bank] identifyBank rate-limited for ${senderEmail}; deferring, messageId=${messageId}`,
            );
            await this.ingestionRepository.markProcessed({
              emailConnectionId: connectionId,
              gmailMessageId: messageId,
              outcome: 'non_transaction',
            });
            return false;
          }
          throw err;
        }

        if (!identified) {
          logger.info(`[Bank] AI: not a bank email from ${senderEmail}, messageId=${messageId}`);
          await this.ingestionRepository.markProcessed({
            emailConnectionId: connectionId,
            gmailMessageId: messageId,
            outcome: 'non_transaction',
          });
          return false;
        }

        if (domainHintBank && domainHintBank.shortCode !== identified.shortCode) {
          logger.warn(
            `[Bank] AI/domain mismatch for ${senderEmail}: ai=${identified.shortCode}, domain_hint=${domainHintBank.shortCode}; using domain hint`,
          );
          bank = domainHintBank;
        }

        if (bank) {
          logger.info(
            `[Bank] domain_name_hint: selected "${bank.name}" from ${senderEmail}, messageId=${messageId}`,
          );
        } else {
          logger.info(
            `[Bank] ai_identified: "${identified.name}" from ${senderEmail} — registering, messageId=${messageId}`,
          );
          bank = await this.bankRepository.upsertByShortCode({
            name: identified.name,
            shortCode: identified.shortCode,
            country: identified.country,
            senderEmail,
          });
        }
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

      const dbCategories = await this.getCachedCategories();

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
        const transactionDate = this.resolveTransactionDate(
          regexResult.date,
          emailBody,
          emailSubject,
        );
        const merchant = this.resolveMerchant(
          (regexResult.merchant as string) || undefined,
          emailBody,
          emailSubject,
        );
        const currency = (regexResult.currency as string) || user.refCurrency;
        const learnedCategory = await this.transactionRepository.findLearnedCategoryForMerchant(
          userId,
          merchant,
        );
        const categoryResolution = this.resolveCategory(
          merchant,
          emailSubject,
          emailBody,
          dbCategories,
          regexResult.category as string | undefined,
          learnedCategory,
        );
        const category = categoryResolution.category;
        const reference = this.sanitizeReference(regexResult.reference as string | undefined);

        const isDuplicate = await this.transactionRepository.existsSimilarTransaction({
          userId,
          bankId: bank.id,
          currency,
          amountAbs: Math.abs(signedAmount),
          transactionType: normalizedType,
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
          status: categoryResolution.verified ? TransactionStatusEnum.VERIFIED : TransactionStatusEnum.UNVERIFIED,
          reference,
          balance: regexResult.balance as number | undefined,
        });

        setImmediate(() => {
          this.parserRuleService.recordMatch(templateResult.templateId).catch((err) => {
            logger.error(`Failed to record regex match for template ${templateResult.templateId} - ${err}`);
          });
          this.parserRuleService
            .captureBlueprint(bank.id, normalizedType, emailSubject, emailBody)
            .catch((err) => {
              logger.error(`Failed to capture blueprint for bank ${bank.id} - ${err}`);
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
      const merchant = this.resolveMerchant(
        (extractedOrFallback.merchant as string) || undefined,
        emailBody,
        emailSubject,
      );
      const extractedDate = this.resolveTransactionDate(
        extractedOrFallback.date,
        emailBody,
        emailSubject,
      );
      const learnedCategory = await this.transactionRepository.findLearnedCategoryForMerchant(
        userId,
        merchant,
      );
      const categoryResolution = this.resolveCategory(
        merchant,
        emailSubject,
        emailBody,
        dbCategories,
        extractedOrFallback.category as string | undefined,
        learnedCategory,
      );
      const category = categoryResolution.category;
      const reference = this.sanitizeReference(extractedOrFallback.reference as string | undefined);

      const isDuplicate = await this.transactionRepository.existsSimilarTransaction({
        userId,
        bankId: bank.id,
        currency: extractedCurrency,
        amountAbs: Math.abs(signedAmount),
        transactionType: normalizedType,
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
        status: categoryResolution.verified ? TransactionStatusEnum.VERIFIED : TransactionStatusEnum.UNVERIFIED,
        reference,
        balance: extractedOrFallback.balance as number | undefined,
      });

      await this.ingestionRepository.markProcessed({
        emailConnectionId: connectionId,
        gmailMessageId: messageId,
        outcome: 'parsed',
        transactionId: transaction.id,
      });
      setImmediate(() => {
        this.parserRuleService
          .captureBlueprint(bank.id, normalizedType, emailSubject, emailBody)
          .catch((err) => {
            logger.error(`Failed to capture blueprint for bank ${bank.id} - ${err}`);
          });
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
    const referenceRaw = this.extractFieldValue(combined, [
      'transaction\\s+reference',
      'reference\\s+code',
      'document\\s+number',
      'reference',
    ]);
    const descriptionRaw = this.extractFieldValue(combined, ['description']);
    const narrationRaw = this.extractFieldValue(combined, ['narration']);
    const beneficiaryRaw = this.extractFieldValue(combined, ['beneficiary\\s+name']);
    const dateRaw = this.extractFieldValue(combined, [
      'transaction\\s+date\\s*&\\s*time',
      'transaction\\s+date',
      'value\\s+date',
      'time\\s+of\\s+transaction',
      'effective\\s+date',
      'date\\s+of\\s+transaction',
    ]);

    const typeMatch = combined.match(/\b(debit|credit)\b/i);
    const parsedAmount = parseFloat((amountMatch[2] || '').replace(/,/g, ''));
    if (!isFinite(parsedAmount)) return null;

    return {
      amount: parsedAmount,
      currency: amountMatch[1] || balanceMatch?.[1] || undefined,
      merchant: this.sanitizeMerchant(beneficiaryRaw || narrationRaw || descriptionRaw || ''),
      transactionType: (typeMatch?.[1] || '').toLowerCase() || TransactionTypeEnum.DEBIT,
      date: this.normalizeDateString(dateRaw),
      balance: balanceMatch?.[2]
        ? parseFloat(balanceMatch[2].replace(/,/g, ''))
        : undefined,
      reference: this.sanitizeReference(referenceRaw),
    };
  }

  private extractFieldValue(input: string, labels: string[]): string | undefined {
    const stop = [
      'amount',
      'current\\s+balance',
      'available\\s+balance',
      'description',
      'transaction\\s+reference',
      'document\\s+number',
      'account\\s+number',
      'transaction\\s+date',
      'time\\s+of\\s+transaction',
      'value\\s+date',
      'effective\\s+date',
      'date\\s+of\\s+transaction',
      'your\\s+branch',
      'remember',
      'thank\\s+you\\s+for\\s+banking',
      'if\\s+you\\s+need\\s+assistance',
      'do\\s+not\\s+respond\\s+to\\s+emails',
      'support@[a-z0-9._%+-]+\\.[a-z]{2,}',
      'how\\s+did\\s+you\\s+feel',
      'this\\s+is\\s+an\\s+online\\s+auto\\s+generated',
    ];
    const labelAlternation = labels.join('|');
    const stopAlternation = stop.join('|');
    const regex = new RegExp(
      `(?:${labelAlternation})\\s*[:\\n ]\\s*([\\s\\S]*?)(?=\\n\\s*(?:${stopAlternation})\\b|\\s+(?:${stopAlternation})\\b|$)`,
      'i',
    );
    const match = input.match(regex);
    return match?.[1]?.trim();
  }

  private normalizeDateString(input?: string): string | undefined {
    if (!input) return undefined;
    const cleaned = input.replace(/\./g, '').trim();
    const parsed = new Date(cleaned);
    if (isNaN(parsed.getTime())) return undefined;
    return parsed.toISOString();
  }

  private sanitizeMerchant(value: string | undefined): string {
    if (!value) return 'Unknown';
    let text = value
      .replace(/\s+/g, ' ')
      .trim();

    const stopPhrases = [
      'Transaction Reference',
      'Account Number',
      'Transaction Date',
      'Date of Transaction',
      'Effective Date',
      'Your Branch',
      'How did you feel',
      'This is an online auto generated',
      'Please note that this transaction',
      'If you need assistance',
      'Do not respond to emails',
      'Thank you for Banking with us',
      'Remember: Keep your card and Pin information secure',
      'support@',
    ];
    for (const phrase of stopPhrases) {
      const idx = text.toLowerCase().indexOf(phrase.toLowerCase());
      if (idx >= 0) {
        text = text.slice(0, idx).trim();
      }
    }

    text = text
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '')
      .replace(/^\d{12,}\s+/i, '')
      .replace(/\bHEAD OFFICE BRANCH\b[\s\S]*$/i, '')
      .replace(/\b(if\s+you\s+need\s+assistance|thank\s+you\s+for\s+banking|remember:)\b[\s\S]*$/i, '')
      .replace(/[\-,:;]+$/g, '')
      .trim();

    if (!text) return 'Unknown';
    return text.length > 120 ? text.slice(0, 120).trim() : text;
  }

  private sanitizeReference(value: string | undefined): string | undefined {
    if (!value) return undefined;
    let text = value
      .replace(/\s+/g, ' ')
      .trim();

    const stopPhrases = [
      'Account Number',
      'Transaction Date',
      'Your Branch',
      'How did you feel',
      'This is an online auto generated',
    ];
    for (const phrase of stopPhrases) {
      const idx = text.toLowerCase().indexOf(phrase.toLowerCase());
      if (idx >= 0) {
        text = text.slice(0, idx).trim();
      }
    }

    const canonicalRef = text.match(/[A-Z0-9][A-Z0-9/-]{4,}/i)?.[0];
    return canonicalRef || undefined;
  }

  private resolveMerchant(rawMerchant: string | undefined, body: string, subject: string): string {
    const direct = this.sanitizeMerchant(rawMerchant);
    if (direct !== 'Unknown') return direct;

    const heuristic = this.extractMerchantHeuristic(body, subject);
    return this.sanitizeMerchant(heuristic);
  }

  private extractMerchantHeuristic(body: string, subject: string): string | undefined {
    const combined = `${subject}\n${body}`;
    const labeled = this.extractFieldValue(combined, [
      'beneficiary\\s+name',
      'recipient\\s+name',
      'receiver\\s+name',
      'narration',
      'description',
      'merchant',
      'payment\\s+to',
      'transfer\\s+to',
    ]);
    if (labeled) return labeled;

    const subjectPatterns = [
      /payment\s+receipt\s+to\s*\(([^)]+)\)/i,
      /transfer\s+to\s+([A-Za-z0-9 .&'_-]{3,})/i,
      /payment\s+to\s+([A-Za-z0-9 .&'_-]{3,})/i,
    ];
    for (const pattern of subjectPatterns) {
      const match = subject.match(pattern);
      if (match?.[1]) return match[1].trim();
    }

    return undefined;
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

  private resolveTransactionDate(value: string | undefined, body: string, subject: string): Date {
    const primary = this.parseDateCandidate(value);
    if (primary && !this.isMidnight(primary, value)) return primary;

    const combined = `${subject}\n${body}`;
    const labeled = this.extractFieldValue(combined, [
      'transaction\\s+date\\s*&\\s*time',
      'time\\s+of\\s+transaction',
      'effective\\s+date',
      'date\\s+of\\s+transaction',
      'transaction\\s+date',
      'value\\s+date',
    ]);
    const labeledDate = this.parseDateCandidate(labeled);
    if (labeledDate) return labeledDate;

    const looseMatch = combined.match(
      /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\b/,
    )?.[0];
    const looseDate = this.parseDateCandidate(looseMatch);
    if (looseDate) return looseDate;

    if (primary) return primary;
    return new Date();
  }

  private parseDateCandidate(raw: string | undefined): Date | null {
    if (!raw) return null;
    const cleaned = raw.replace(/\./g, '').trim();
    if (!cleaned) return null;

    const parsed = new Date(cleaned);
    if (!isNaN(parsed.getTime())) return parsed;

    const slash = cleaned.match(
      /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
    );
    if (!slash) return null;

    let day = Number(slash[1]);
    let month = Number(slash[2]);
    const yearRaw = Number(slash[3]);
    const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
    const hour = Number(slash[4] ?? 0);
    const minute = Number(slash[5] ?? 0);
    const second = Number(slash[6] ?? 0);

    // Default to day-first for common NG bank formats.
    if (day <= 12 && month > 12) {
      const temp = day;
      day = month;
      month = temp;
    }

    const normalized = new Date(year, month - 1, day, hour, minute, second);
    return isNaN(normalized.getTime()) ? null : normalized;
  }

  private isMidnight(parsed: Date, raw: string | undefined): boolean {
    if (!raw) return false;
    const hasTimeInRaw = /\d{1,2}:\d{2}/.test(raw);
    if (hasTimeInRaw) return false;
    return (
      parsed.getHours() === 0 &&
      parsed.getMinutes() === 0 &&
      parsed.getSeconds() === 0 &&
      parsed.getMilliseconds() === 0
    );
  }

  private async findBankByDomainHint(senderEmail: string): Promise<IBank | null> {
    const at = senderEmail.lastIndexOf('@');
    if (at < 0 || at === senderEmail.length - 1) return null;
    const domain = senderEmail.slice(at + 1).toLowerCase();
    const root = domain.replace(/^mail\./, '').replace(/^m\./, '');
    const compactDomain = root.replace(/[^a-z0-9]/g, '');
    if (!compactDomain) return null;

    const banks = await this.bankRepository.findAll();
    const ignored = new Set(['bank', 'plc', 'ltd', 'limited', 'nigeria', 'ng', 'group']);
    const matches = banks.filter((bank) => {
      const tokens = [bank.shortCode, bank.name]
        .join(' ')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 4 && !ignored.has(t));
      return tokens.some((token) => compactDomain.includes(token));
    });

    if (matches.length === 1) return matches[0] ?? null;
    return null;
  }

  private async getCachedCategories(): Promise<ICategory[]> {
    const now = Date.now();
    if (this.categoryCache && this.categoryCache.expiresAt > now) {
      return this.categoryCache.categories;
    }
    const categories = await this.categoryRepository.findActiveWithRegex();
    this.categoryCache = { categories, expiresAt: now + CATEGORY_CACHE_TTL_MS };
    return categories;
  }

  private resolveCategory(
    merchant: string,
    subject: string,
    body: string,
    categories: ICategory[],
    extractedCategory?: string,
    learnedCategory?: string | null,
  ): CategoryResolution {
    if (learnedCategory) {
      return { category: learnedCategory, source: 'learned', verified: true };
    }

    const normalized = `${merchant} ${subject} ${body}`.toLowerCase();
    for (const cat of categories) {
      if (!cat.regex) continue;
      try {
        const pattern = new RegExp(cat.regex, 'i');
        if (pattern.test(normalized)) {
          return { category: cat.slug, source: 'regex_rule', matchedRule: cat.regex, verified: false };
        }
      } catch {
        // skip malformed regex
      }
    }

    if (extractedCategory) {
      const maybeSlug = extractedCategory.toLowerCase().trim();
      if (maybeSlug) {
        return { category: maybeSlug, source: 'extracted', verified: false };
      }
    }

    return { category: CategoryEnum.UNCATEGORIZED, source: 'default_uncategorized', verified: false };
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
      // named entities
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      // numeric entities — replace with space so currency symbols (e.g. &#8358; = NGN)
      // don't block amount-pattern matching downstream
      .replace(/&#x[0-9a-fA-F]+;/g, ' ')
      .replace(/&#\d+;/g, ' ')
      // any remaining named entities we don't recognise
      .replace(/&[a-zA-Z]{2,8};/g, ' ')
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
