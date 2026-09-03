import { inject, injectable } from 'tsyringe';
import { google } from 'googleapis';
import logger from '@/common/lib/logger';
import syncEventBus from '@/common/lib/sync-event-bus';
import { IIngestionRepository } from './ingestion.repository';
import { IEmailConnectionRepository } from '@/modules/email-connection/email-connection.repository';
import { IBankRepository } from '@/modules/bank/bank.repository';
import { IParserRuleService, IdentifiedBank } from '@/modules/parser-rule/parser-rule.service';
import { RateLimitedExtractionError, ParsedTransaction } from '@/modules/parser-rule/parser-rule.interface';
import { ITransactionRepository } from '@/modules/transaction/transaction.repository';
import { IExchangeRateService } from '@/modules/exchange-rate/exchange-rate.service';
import { IUserRepository } from '@/modules/user/user.repository';
import { getRetentionMonthsForPlan } from '@/modules/user/user.constants';
import EmailConnectionService, {
  IEmailConnectionService,
} from '@/modules/email-connection/email-connection.service';
import ParserRuleService from '@/modules/parser-rule/parser-rule.service';
import NotificationService, { INotificationService } from '@/modules/notification/notification.service';
import BudgetService, { IBudgetService } from '@/modules/budget/budget.service';
import AccountService, { IAccountService } from '@/modules/account/account.service';
import TransferDetectionService, { ITransferDetectionService } from '@/modules/account/transfer-detection.service';
import { TransactionTypeEnum, TransactionStatusEnum, CategoryEnum } from '@/modules/transaction/transaction.enum';
import { ICategoryRepository } from '@/modules/category/category.repository';
import { ICategory } from '@/modules/category/category.interface';
import { IBank } from '@/modules/bank/bank.interface';
import { CONSTANTS } from '@/common/configuration/constants';
import { getIngestionQueue } from './ingestion.queue';
import { GmailAuthRevokedError } from '@/modules/email-connection/email-connection.service';
import { BankIdentificationSource } from '@/modules/bank/bank-matching';
import * as iconv from 'iconv-lite';
import { convert } from 'html-to-text';

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
// A manual poll (fresh backfill or "sync now" after a while away) can have a large
// outstanding backlog, unlike the steady-state cron cadence which rarely sees more
// than a handful of new messages per cycle. Processing that backlog in one dense
// burst is what trips OpenAI's rate limit in the first place (fintrack-backend#137,
// complements the retry mechanism in #136). Chunk manual polls smaller and pace
// the remainder via delayed follow-up jobs instead of draining everything at once.
const INGESTION_BACKFILL_CHUNK_SIZE = 15;
const INGESTION_BACKFILL_CHUNK_DELAY_MS = 60 * 1000;
const INGESTION_MESSAGE_PACING_MS = 400;
// Bank alert emails are near-real-time, so a resolved transaction date should
// land close to when the email was actually received. A candidate outside this
// window (a regex/AI grab on a footer date, a copyright year, an unrelated
// promo date, ...) is almost always wrong, not a legitimately old transaction.
// See fintrack-backend#162.
const INGESTION_DATE_SANITY_TOLERANCE_DAYS = 3;
// recordFailure only fires today on an unparseable amount or a low-quality
// merchant - a template that extracts a wrong-but-well-formed amount, date, or
// merchant is never caught. For a sample of production-template matches, also
// run AI extraction in the background and compare fields; a divergence records
// a failure the same way, feeding the existing confidence/demotion machinery.
// Kept low and off the critical path since every sampled match costs an AI
// call. See fintrack-backend#163.
const SHADOW_VERIFY_SAMPLE_RATE = 0.08;
// Onboarding tells free-tier users we're scanning "the last 2 months" (their
// retention window, see user.constants.ts). Nothing previously enforced any
// bound at all, so a manual/backfill poll would walk a label's entire history
// via nextPageToken with no end condition. Gmail's `after:` search operator is
// date-only (no time component), so this is a day-granular cutoff, not a
// precise timestamp. Paid/unlimited tier still gets a generous cap rather than
// a truly unbounded scan, since a mailbox with years of history in the label
// would otherwise be able to repeat the same runaway cost this bounds.
const INGESTION_BACKFILL_UNLIMITED_SAFETY_CAP_DAYS = 730;

export function resolveBackfillWindowDays(planTier: string): number {
  const retentionMonths = getRetentionMonthsForPlan(planTier);
  return retentionMonths != null ? retentionMonths * 30 : INGESTION_BACKFILL_UNLIMITED_SAFETY_CAP_DAYS;
}

export function formatGmailAfterDate(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface TransactionSignal {
  isTransaction: boolean;
  reason: string;
}

interface CategoryResolution {
  category: string;
  source: 'learned' | 'regex_rule' | 'extracted' | 'ai_fallback' | 'default_uncategorized';
  matchedRule?: string;
  verified: boolean;
}

// A transaction created by processMessage, threaded back to the poll loop so
// the sync-complete notification can name real merchants/amounts instead of
// just reporting a count.
export interface ProcessedTransaction {
  merchant: string;
  category: string;
  refAmount: number;
  refCurrency: string;
}

// Kept in sync with the frontend's CATEGORY_LABELS
// (fintrack-frontend/src/features/transactions/transactions.constants.ts) —
// only used here for notification copy, so an exact 1:1 isn't load-bearing.
const CATEGORY_LABELS: Record<string, string> = {
  peer_to_peer_transfer: 'Peer Transfer',
  business_payment: 'Business Payment',
  subscriptions: 'Subscriptions',
  entertainment_leisure: 'Entertainment',
  mobile_internet: 'Mobile & Internet',
  utilities: 'Utilities',
  groceries: 'Groceries',
  retail_ecommerce: 'Retail & Shopping',
  dining_food_delivery: 'Dining & Delivery',
  transport: 'Transport',
  fuel_auto: 'Fuel & Auto',
  travel: 'Travel',
  bank_charges: 'Bank Charges',
  currency_conversion: 'FX Conversion',
  self_transfer: 'Self-Transfer',
  investment: 'Investment',
  savings: 'Savings',
  rent_housing: 'Rent & Housing',
  salary_wages: 'Salary & Wages',
  refunds_reimbursements: 'Refunds',
  healthcare: 'Healthcare',
  education: 'Education',
  charity_donations: 'Charity',
  cash_withdrawal: 'Cash Withdrawal',
  family_support: 'Family Support',
  beauty_personal_care: 'Beauty & Care',
  gifts_social: 'Gifts & Social',
  uncategorized: 'Uncategorized',
};

function categoryLabel(slug: string): string {
  return CATEGORY_LABELS[slug] ?? slug.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  NGN: '₦',
  USD: '$',
  GBP: '£',
  EUR: '€',
  GHS: '₵',
  KES: 'KSh',
  ZAR: 'R',
};

function formatAmount(amount: number, currency: string): string {
  const symbol = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  return `${symbol}${Math.round(amount).toLocaleString('en-US')}`;
}

export interface IIngestionService {
  pollAllConnections(): Promise<void>;
  pollConnection(
    connectionId: number,
    source?: TriggerSource,
    pageToken?: string,
    backfillCutoffDate?: string,
    invokedFromQueue?: boolean,
  ): Promise<void>;
  enqueuePoll(connectionId: number, source?: TriggerSource): Promise<void>;
  reconcileFailedBackfill(connectionId: number): Promise<void>;
  processMessage(
    connectionId: number,
    messageId: string,
    emailBody: string,
    emailSubject: string,
    fromAddress: string,
    receivedAt?: Date,
  ): Promise<ProcessedTransaction | null>;
}

@injectable()
class IngestionService implements IIngestionService {
  // Keyed by `${bankId}:${formatSignature}`, not bare bankId, so one format's
  // in-flight generation or rate-limit cooldown doesn't block a different
  // format from the same bank (fintrack-backend#160).
  private templateGenerationInFlight = new Set<string>();
  private templateGenerationCooldownUntil = new Map<string, number>();
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
    @inject(BudgetService) private budgetService: IBudgetService,
    @inject(AccountService) private accountService: IAccountService,
    @inject(TransferDetectionService) private transferDetectionService: ITransferDetectionService,
  ) {}

  async pollAllConnections(): Promise<void> {
    try {
      const connections = await this.connectionRepository.findAllActive();
      const queue = getIngestionQueue();

      if (queue) {
        logger.info(`[Ingestion] Enqueueing ${connections.length} connection(s) for polling`);
        await Promise.all(
          connections.map((c) =>
            queue.add('poll', { connectionId: c.id, source: 'cron' }, {
              // Deduplication key expires just before the next cron cycle so the same
              // connection isn't polled twice concurrently, but CAN be re-queued on the
              // next tick. Using jobId instead would block re-enqueueing for as long as
              // the completed job's data key persists in Redis (removeOnComplete: {count}).
              deduplication: {
                id: `cron-${c.id}`,
                ttl: (CONSTANTS.GMAIL_POLL_INTERVAL_MINUTES - 1) * 60 * 1000,
              },
              priority: 10,
            }),
          ),
        );
      } else {
        logger.info(`[Ingestion] Polling ${connections.length} active email connections (direct)`);
        await Promise.all(connections.map((c) => this.pollConnection(c.id)));
      }
    } catch (error) {
      logger.error(`Error in pollAllConnections - ${error}`);
    }
  }

  async enqueuePoll(connectionId: number, source: TriggerSource = 'manual'): Promise<void> {
    const queue = getIngestionQueue();
    if (queue) {
      await queue.add('poll', { connectionId, source }, { priority: 1 });
    } else {
      // No Redis — fire and forget directly, matching original behaviour.
      this.pollConnection(connectionId, source).catch((err) =>
        logger.error(`[Ingestion] Direct poll failed for connection ${connectionId} - ${err}`),
      );
    }
  }

  /**
   * Paces a manual poll's remaining backlog instead of draining it in one dense
   * burst — schedules the next chunk via a delayed BullMQ job when Redis is
   * available (the primary path in production), or a defensive setTimeout
   * fallback otherwise, mirroring enqueuePoll's Redis-vs-direct branching.
   * Carries the Gmail pageToken forward so the next chunk actually continues
   * from where this one left off, instead of re-fetching the same first page.
   */
  private scheduleNextPollChunk(
    connectionId: number,
    source: TriggerSource,
    pageToken: string,
    backfillCutoffDate: string,
  ): void {
    const queue = getIngestionQueue();
    if (queue) {
      queue
        .add(
          'poll',
          { connectionId, source, pageToken, backfillCutoffDate },
          { delay: INGESTION_BACKFILL_CHUNK_DELAY_MS, priority: 1 },
        )
        .catch((err) => logger.error(`[Ingestion] Failed to schedule next chunk for connection ${connectionId} - ${err}`));
    } else {
      setTimeout(() => {
        this.pollConnection(connectionId, source, pageToken, backfillCutoffDate).catch((err) =>
          logger.error(`[Ingestion] Direct chunked poll failed for connection ${connectionId} - ${err}`),
        );
      }, INGESTION_BACKFILL_CHUNK_DELAY_MS);
    }
  }

  async pollConnection(
    connectionId: number,
    source: TriggerSource = 'cron',
    pageToken?: string,
    backfillCutoffDate?: string,
    invokedFromQueue: boolean = false,
  ): Promise<void> {
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

      // A manual poll may be sitting on a large backlog (fresh backfill, or a
      // "sync now" after a while away) — chunk it smaller than the steady-state
      // cron cadence and pace the remainder via a delayed follow-up instead of
      // draining everything in one dense burst. See fintrack-backend#137.
      const isManualPoll = source === 'manual';

      // A pageToken is only valid for the exact query that produced it. One that
      // arrives without a paired backfillCutoffDate was enqueued by pre-fix code
      // (before after: filtering existed), so honoring it against a freshly
      // computed cutoff would send Gmail a pageToken from a different query,
      // which it rejects. Discard it and restart the chain fresh instead.
      const hasUnpairedPageToken = !!pageToken && !backfillCutoffDate;
      if (hasUnpairedPageToken) {
        logger.warn(
          `[Ingestion] Connection ${connectionId} received a pageToken with no paired cutoff (pre-fix job): restarting backfill chain from the start`,
        );
      }
      const effectivePageToken = hasUnpairedPageToken ? undefined : pageToken;

      // Pinned on this run's first chunk (no pageToken, or an unpaired one just
      // discarded above) and carried forward unchanged on every follow-up: a
      // pageToken is only valid for the exact query that produced it, so
      // recomputing the window fresh on each chunk would silently change the
      // query mid-pagination the moment a run crosses a day boundary. See
      // fintrack-backend#158.
      let resolvedCutoffDate: string | undefined = hasUnpairedPageToken ? undefined : backfillCutoffDate;
      if (isManualPoll && !resolvedCutoffDate) {
        const user = await this.userRepository.findById(connection.userId);
        const windowDays = resolveBackfillWindowDays(user?.planTier ?? 'free');
        resolvedCutoffDate = formatGmailAfterDate(new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000));
      }

      const listResp = await gmail.users.messages.list({
        userId: 'me',
        labelIds: [connection.gmailLabelId],
        maxResults: isManualPoll ? INGESTION_BACKFILL_CHUNK_SIZE : 50,
        pageToken: effectivePageToken,
        ...(isManualPoll ? { q: `after:${resolvedCutoffDate}` } : {}),
      });

      const messages = listResp.data.messages || [];
      const total = messages.length;
      const nextPageToken = listResp.data.nextPageToken;
      const hasMoreBacklog = isManualPoll && !!nextPageToken;
      logger.info(`[Ingestion] Found ${total} messages in label "${labelName}" for connection ${connectionId}${hasMoreBacklog ? ' (more queued for a paced follow-up)' : ''}`);

      // Persisted so other features (Iris's first insight, in particular) can
      // tell a connection's transaction set isn't final yet, independent of any
      // single poll invocation. Set as soon as we know, not after processing
      // this chunk, so a mid-chunk failure doesn't leave stale state.
      if (isManualPoll) {
        await this.connectionRepository.updateBackfillPending(connectionId, hasMoreBacklog);
      }

      emit('start', { total });

      let processedCount = 0;
      let doneIndex = 0;
      let attemptedIndex = 0;
      const processedTransactions: ProcessedTransaction[] = [];

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

        // Pace only actual (AI-driving) attempts, not the skip-only fast path for
        // messages already processed — no point slowing down a mostly-caught-up
        // poll that has nothing left to do.
        if (attemptedIndex > 0) await delay(INGESTION_MESSAGE_PACING_MS);
        attemptedIndex++;

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
          const internalDateMs = Number(msgResp.data.internalDate);
          const receivedAt = Number.isFinite(internalDateMs) && internalDateMs > 0
            ? new Date(internalDateMs)
            : new Date();

          const processed = await this.processMessage(connectionId, msg.id, body, subject, from, receivedAt);
          if (processed) {
            processedCount++;
            processedTransactions.push(processed);
          }
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

      if (hasMoreBacklog && nextPageToken) {
        logger.info(`[Ingestion] Chunk complete for connection ${connectionId}: ${processedCount} new transactions from ${total} messages — scheduling next chunk in ${INGESTION_BACKFILL_CHUNK_DELAY_MS / 1000}s`);
        // hasMoreBacklog implies isManualPoll, which is exactly the branch above
        // that guarantees resolvedCutoffDate is set.
        this.scheduleNextPollChunk(connectionId, source, nextPageToken, resolvedCutoffDate!);
      } else {
        logger.info(`[Ingestion] Poll complete for connection ${connectionId}: ${processedCount} new transactions from ${total} messages`);
      }
      // stillScanning tells the client this chunk's count isn't the final word —
      // more of the backlog is still being paced in via follow-up chunks. Without
      // it, onboarding (or any other "done" listener) would treat the first
      // chunk's count as complete and celebrate a partial number.
      emit('done', { added: processedCount, stillScanning: hasMoreBacklog });

      // Create a notification — always for manual/SSE (once the backlog is fully
      // drained, not per intermediate chunk — a chunk isn't a real "sync complete"
      // moment and would just spam a misleading notification), only when new
      // transactions for cron.
      const userId = connection.userId;
      if ((isManualPoll && !hasMoreBacklog) || (!isManualPoll && processedCount > 0)) {
        await this.notificationService.create({
          userId,
          type: 'sync_complete',
          title: processedCount > 0 ? 'Sync complete' : 'Sync complete — nothing new',
          body: this.buildSyncNotificationBody(processedTransactions),
          data: { added: processedCount, connectionId },
        });
      }

      if (processedCount > 0 && CONSTANTS.FEATURES.BUDGETING_ENABLED) {
        this.budgetService.checkBudgetAlerts(userId).catch(() => {});
      }
    } catch (error) {
      if (error instanceof GmailAuthRevokedError) {
        logger.warn(`[Ingestion] Connection ${connectionId} requires re-auth (invalid_grant)`);
        emit('error', { message: 'Gmail access was revoked — please reconnect your account' });
        // Terminal: retrying won't fix an invalid_grant, and this never reaches
        // the queue's own retry/failure bookkeeping since it returns instead of
        // throwing. Clear backfillPending directly here (for a manual chunk) so
        // it doesn't stay stuck true forever waiting for a chunk that will never
        // resume, blocking Iris insight generation. See fintrack-backend#158.
        if (source === 'manual') {
          await this.connectionRepository.updateBackfillPending(connectionId, false).catch(() => {});
        }
        try {
          const conn = await this.connectionRepository.findByIdOnly(connectionId);
          if (conn?.userId) {
            await this.notificationService.create({
              userId: conn.userId,
              type: 'sync_failed',
              title: 'Gmail reconnection required',
              body: 'Your Gmail access has expired or been revoked. Please reconnect your account to continue syncing.',
              data: { connectionId, reason: 'auth_revoked' },
            });
          }
        } catch {
          // ignore notification failure
        }
        return;
      }

      logger.error(`[Ingestion] Error polling connection ${connectionId} - ${error}`);
      emit('error', { message: 'Sync failed unexpectedly' });

      // A queue-invoked failure may still be retried by BullMQ below, so notifying
      // here would be premature (and, for a chunk that goes on to succeed on retry,
      // outright wrong). Direct/SSE invocations have no retry mechanism, so their
      // first failure is already final. The queue-invoked terminal case (retries
      // exhausted) is notified separately, from the worker's own failed handler in
      // ingestion.queue.ts, which is the only place that knows retries are done.
      if (source === 'manual' && !invokedFromQueue) {
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

      // Previously this error was always swallowed, so a queued chunk job always
      // resolved successfully: BullMQ's retry/backoff never fired, the rest of a
      // manual backfill's backlog was silently dropped, and backfillPending stayed
      // true forever. Rethrowing here lets the worker's job promise reject, so
      // BullMQ retries with its configured backoff instead. See fintrack-backend#158.
      if (invokedFromQueue) {
        throw error;
      }
    }
  }

  async reconcileFailedBackfill(connectionId: number): Promise<void> {
    try {
      const conn = await this.connectionRepository.findByIdOnly(connectionId);
      await this.connectionRepository.updateBackfillPending(connectionId, false);
      if (conn?.userId) {
        await this.notificationService.create({
          userId: conn.userId,
          type: 'sync_failed',
          title: 'Sync failed',
          body: 'Something went wrong while reading your Gmail. Please try again.',
          data: { connectionId },
        });
      }
    } catch (err) {
      logger.error(`[Ingestion] Failed to reconcile backfill state for connection ${connectionId} - ${err}`);
    }
  }

  // Single/few transactions: name them. Bulk (first-time connect, large cron
  // batch): switch to a summarized digest instead of naming each one.
  private buildSyncNotificationBody(transactions: ProcessedTransaction[]): string {
    const BULK_THRESHOLD = 5;

    if (transactions.length === 0) {
      return 'No new bank emails were found in your label.';
    }

    if (transactions.length > BULK_THRESHOLD) {
      const total = transactions.reduce((acc, t) => acc + t.refAmount, 0);
      const currency = transactions[0].refCurrency;

      const categoryCounts = transactions.reduce((acc: Record<string, number>, t) => {
        acc[t.category] = (acc[t.category] || 0) + 1;
        return acc;
      }, {});
      const topCategories = Object.entries(categoryCounts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 2)
        .map(([cat]) => categoryLabel(cat));
      const mostly = topCategories.length > 0 ? `, mostly ${topCategories.join(' and ')}` : '';

      return `${transactions.length} transactions added — ${formatAmount(total, currency)} total${mostly}`;
    }

    const named = transactions.map((t) => `${formatAmount(t.refAmount, t.refCurrency)} at ${t.merchant}`);
    const joined = named.length === 1
      ? named[0]
      : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;

    return `${joined} added`;
  }

  async processMessage(
    connectionId: number,
    messageId: string,
    emailBody: string,
    emailSubject: string,
    fromAddress: string,
    receivedAt: Date = new Date(),
  ): Promise<ProcessedTransaction | null> {
    try {
      const connection = await this.connectionRepository.findByIdOnly(connectionId);
      const userId = connection?.userId;
      if (!userId) return null;

      const alreadyProcessed = await this.ingestionRepository.isAlreadyProcessedForUser(
        userId,
        messageId,
      );
      if (alreadyProcessed) return null;

      const senderEmail = this.extractEmail(fromAddress);
      const transactionSignal = this.getTransactionSignal(emailBody, emailSubject);
      const bankMatch = await this.bankRepository.findBySenderEmail(senderEmail);
      let bank = bankMatch?.bank ?? null;
      const domainHintBank = bank ? null : await this.findBankByDomainHint(senderEmail);
      let bankMatchSource: BankIdentificationSource | undefined = bankMatch?.source;

      if (bankMatch) {
        logger.info(
          `[Bank] ${bankMatch.source}: matched "${bank!.name}" from ${senderEmail}, messageId=${messageId}`,
        );
      }

      if (!bank && domainHintBank) {
        bank = domainHintBank;
        bankMatchSource = 'domain_name_hint';
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
          return null;
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
            await this.ingestionRepository.markRetryable(connectionId, messageId);
            return null;
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
          return null;
        }

        if (domainHintBank && domainHintBank.shortCode !== identified.shortCode) {
          logger.warn(
            `[Bank] AI/domain mismatch for ${senderEmail}: ai=${identified.shortCode}, domain_hint=${domainHintBank.shortCode}; using domain hint`,
          );
          bank = domainHintBank;
          bankMatchSource = 'domain_name_hint';
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
          bankMatchSource = 'ai_identified';
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
        return null;
      }

      const user = await this.userRepository.findById(userId);
      if (!user) return null;

      const dbCategories = await this.getCachedCategories();

      const templateResult = await this.parserRuleService.applyTemplate(
        bank.id,
        emailBody,
        emailSubject,
      );

      // status === 'production' (enforced by findProductionTemplatesByBank inside
      // applyTemplate) is already the real, evidence-based check — auditTemplate
      // only promotes a template after either concrete blueprint-match evidence or
      // an AI judge's review. confidenceScore is downstream telemetry fed by real
      // usage below (recordMatch/recordFailure), not a second gate on top of that
      // — it can never rise off its 0 default if usage is gated behind it first.
      // See fintrack-backend#154.
      if (templateResult && Object.keys(templateResult.parsed).length > 0) {
        const regexResult = templateResult.parsed;
        const normalizedType = this.normalizeTransactionType(regexResult.transactionType);
        const parsedAmount = this.parsePositiveAmount(regexResult.amount);
        if (parsedAmount == null) {
          logger.warn(
            `[Ingestion] Template ${templateResult.templateId} produced invalid amount for messageId=${messageId}; falling back to AI extraction`,
          );
          setImmediate(() => {
            this.parserRuleService.recordFailure(templateResult.templateId).catch((err) => {
              logger.error(`Failed to record regex failure for template ${templateResult.templateId} - ${err}`);
            });
          });
        } else {
        const signedAmount = this.toSignedAmount(parsedAmount, normalizedType);
        let transactionDate = this.resolveTransactionDate(
          regexResult.date,
          emailBody,
          emailSubject,
          receivedAt,
        );
        const rawMerchant = (regexResult.merchant as string) || undefined;
        let merchant = this.resolveMerchant(rawMerchant, emailBody, emailSubject);
        let extractedCategoryHint: string | undefined = regexResult.category as string | undefined;
        const needsMerchantRepair = this.isLowQualityMerchant(merchant);
        // resolveTransactionDate's cascade already rejects implausible candidates
        // (fintrack-backend#162) and falls back to receivedAt when nothing
        // plausible was found - landing exactly on receivedAt is the signal the
        // regex's date rule produced nothing usable, not that the transaction
        // genuinely happened at the moment the email was processed.
        const needsDateRepair = transactionDate.getTime() === receivedAt.getTime();
        if (needsMerchantRepair || needsDateRepair) {
          const repaired = await this.repairFieldsWithAi(
            bank.name,
            emailBody,
            emailSubject,
            dbCategories,
            receivedAt,
          );
          if (repaired) {
            if (needsMerchantRepair && repaired.merchant) {
              merchant = repaired.merchant;
              extractedCategoryHint = repaired.category || extractedCategoryHint;
              logger.info(
                `[Ingestion] AI merchant repair applied for messageId=${messageId}: "${merchant}"`,
              );
            }
            if (needsDateRepair && repaired.date) {
              transactionDate = repaired.date;
              logger.info(
                `[Ingestion] AI date repair applied for messageId=${messageId}: ${transactionDate.toISOString()}`,
              );
            }
          }

          setImmediate(() => {
            this.parserRuleService.recordFailure(templateResult.templateId).catch((err) => {
              logger.error(`Failed to record regex failure for template ${templateResult.templateId} - ${err}`);
            });
          });
          this.scheduleTemplateGeneration(bank.id, emailBody, emailSubject, bankMatchSource);
        }
        const currency = this.normalizeCurrency(regexResult.currency as string | undefined) || user.refCurrency;
        const learnedCategory = await this.transactionRepository.findLearnedCategoryForMerchant(
          userId,
          merchant,
        );
        const categoryResolution = await this.resolveCategory(
          merchant,
          emailSubject,
          emailBody,
          dbCategories,
          extractedCategoryHint,
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
          return null;
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

        const account = await this.accountService.resolveOrCreate(
          userId,
          bank.id,
          currency,
          regexResult.accountNumberMask,
        );

        const transaction = await this.transactionRepository.create({
          userId,
          emailConnectionId: connectionId,
          bankId: bank.id,
          accountId: account.id,
          parserTemplateId: templateResult.templateId,
          gmailMessageId: messageId,
          merchant,
          originalMerchant: rawMerchant || this.extractMerchantHeuristic(emailBody, emailSubject),
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

        await this.transferDetectionService.detectForTransaction(transaction);

        setImmediate(() => {
          this.parserRuleService.recordMatch(templateResult.templateId).catch((err) => {
            logger.error(`Failed to record regex match for template ${templateResult.templateId} - ${err}`);
          });
          this.parserRuleService
            .captureBlueprint(bank.id, normalizedType, emailSubject, emailBody)
            .catch((err) => {
              logger.error(`Failed to capture blueprint for bank ${bank.id} - ${err}`);
            });

          if (Math.random() < SHADOW_VERIFY_SAMPLE_RATE) {
            this.shadowVerifyTemplateMatch(
              templateResult.templateId,
              bank.name,
              emailBody,
              emailSubject,
              regexResult,
              receivedAt,
              dbCategories,
            ).catch((err) => {
              logger.error(`[ShadowVerify] Failed for template ${templateResult.templateId} - ${err}`);
            });
          }
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
        return { merchant, category, refAmount, refCurrency: user.refCurrency };
        }
      }

      // No production regex template yet — extract directly with AI
      let extracted: ParsedTransaction | null;
      let extractionWasRateLimited = false;
      try {
        extracted = await this.parserRuleService.extractTransaction(
          bank.name,
          emailBody,
          emailSubject,
          dbCategories,
        );
      } catch (err) {
        if (err instanceof RateLimitedExtractionError) {
          extracted = null;
          extractionWasRateLimited = true;
        } else {
          throw err;
        }
      }

      const extractedOrFallback = extracted || this.extractStructuredFallback(emailBody, emailSubject);

      if (!extractedOrFallback) {
        if (extractionWasRateLimited) {
          logger.warn(`Rate-limited extraction for ${bank.name}, messageId=${messageId} — deferring for retry`);
          await this.ingestionRepository.markRetryable(connectionId, messageId);
          return null;
        }
        logger.info(`AI extraction returned non-transaction for ${bank.name}, messageId=${messageId}`);
        try {
          await this.parserRuleService.captureBlueprint(bank.id, 'unknown', emailSubject, emailBody, true);
        } catch (err) {
          logger.error(`Failed to capture failed-extraction blueprint for bank ${bank.id} - ${err}`);
        }
        await this.ingestionRepository.markProcessed({
          emailConnectionId: connectionId,
          gmailMessageId: messageId,
          outcome: 'non_transaction',
        });
        return null;
      }

      const extractedCurrency = this.normalizeCurrency(extractedOrFallback.currency as string | undefined) || user.refCurrency;
      const normalizedType = this.normalizeTransactionType(extractedOrFallback.transactionType);
      const parsedAmount = this.parsePositiveAmount(extractedOrFallback.amount);
      if (parsedAmount == null) {
        logger.info(
          `[Ingestion] Extracted transaction has invalid amount for ${bank.name}, messageId=${messageId}; marking as non_transaction`,
        );
        try {
          await this.parserRuleService.captureBlueprint(bank.id, normalizedType, emailSubject, emailBody, true);
        } catch (err) {
          logger.error(`Failed to capture failed-extraction blueprint for bank ${bank.id} - ${err}`);
        }
        await this.ingestionRepository.markProcessed({
          emailConnectionId: connectionId,
          gmailMessageId: messageId,
          outcome: 'non_transaction',
        });
        return null;
      }
      const signedAmount = this.toSignedAmount(parsedAmount, normalizedType);
      const rawMerchantAI = (extractedOrFallback.merchant as string) || undefined;
      const merchant = this.resolveMerchant(rawMerchantAI, emailBody, emailSubject);
      const extractedDate = this.resolveTransactionDate(
        extractedOrFallback.date,
        emailBody,
        emailSubject,
        receivedAt,
      );
      const learnedCategory = await this.transactionRepository.findLearnedCategoryForMerchant(
        userId,
        merchant,
      );
      const categoryResolution = await this.resolveCategory(
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
        return null;
      }

      const refAmount = parsedAmount
        ? await this.exchangeRateService.convert(
            Math.abs(parsedAmount),
            extractedCurrency,
            user.refCurrency,
          )
        : 0;

      const exchangeRate = await this.exchangeRateService.getRate(extractedCurrency, user.refCurrency);

      const account = await this.accountService.resolveOrCreate(
        userId,
        bank.id,
        extractedCurrency,
        extractedOrFallback.accountNumberMask,
      );

      const transaction = await this.transactionRepository.create({
        userId,
        emailConnectionId: connectionId,
        bankId: bank.id,
        accountId: account.id,
        gmailMessageId: messageId,
        merchant,
        originalMerchant: rawMerchantAI || this.extractMerchantHeuristic(emailBody, emailSubject),
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

      await this.transferDetectionService.detectForTransaction(transaction);

      await this.ingestionRepository.markProcessed({
        emailConnectionId: connectionId,
        gmailMessageId: messageId,
        outcome: 'parsed',
        transactionId: transaction.id,
      });
      try {
        await this.parserRuleService.captureBlueprint(bank.id, normalizedType, emailSubject, emailBody);
      } catch (err) {
        logger.error(`Failed to capture blueprint for bank ${bank.id} - ${err}`);
      }

      logger.info(
        `Category resolved for messageId=${messageId}: category=${category}, source=${categoryResolution.source}${categoryResolution.matchedRule ? `, rule=${categoryResolution.matchedRule}` : ''}`,
      );

      // Build regex template in background so future emails use fast regex path.
      // Sequenced after captureBlueprint (awaited above) so generation always
      // has this sample available, instead of racing an un-awaited capture.
      this.scheduleTemplateGeneration(bank.id, emailBody, emailSubject, bankMatchSource);

      return { merchant, category, refAmount, refCurrency: user.refCurrency };
    } catch (error) {
      logger.error(`Error processing message ${messageId} - ${error}`);
      await this.ingestionRepository.markProcessed({
        emailConnectionId: connectionId,
        gmailMessageId: messageId,
        outcome: 'failed',
      });
      return null;
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
    accountNumberMask?: string;
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
    let text = value.replace(/\s+/g, ' ').trim();

    // Early-exit: recognise Nigerian bank transaction-type descriptors
    if (/\bsms\s*(alert\s*)?(charge|fee)\b/i.test(text)) return 'SMS Charge';
    if (/\bdata\s*purchase\b/i.test(text)) return 'Data Purchase';
    if (/\bairtime\s*(purchase|top[- ]?up|recharge)?\b/i.test(text)) return 'Airtime';
    if (/\batm\s*(cash\s*)?withdrawal\b/i.test(text)) return 'ATM Withdrawal';
    if (/\bcard\s*maintenance\s*(fee)?\b/i.test(text)) return 'Card Maintenance';
    if (/\baccount\s*maintenance\s*(fee)?\b/i.test(text)) return 'Account Maintenance';
    if (/\bstamp\s*duty\b/i.test(text)) return 'Stamp Duty';
    if (/\b(vat|value\s*added\s*tax)\s*charge\b/i.test(text)) return 'VAT';
    if (/\binterest\s+(charge|fee|debit)\b/i.test(text)) return 'Interest Charge';
    if (/\bloan\s*repayment\b/i.test(text)) return 'Loan Repayment';
    if (/\belectric(ity)?\s*(bill|purchase|token)\b/i.test(text)) return 'Electricity';
    if (/\bwifi|broadband|internet\s*subscription\b/i.test(text)) return 'Internet';
    if (/\bcable\s*(tv|television)\b/i.test(text)) return 'Cable TV';

    // Extract name from transfer narrations
    const transferMatch = text.match(
      /\b(?:(?:inter[- ]?bank|intra[- ]?bank|online|mobile)\s+)?(?:transfer|payment)\s+(?:to|from)\s+([A-Za-z][A-Za-z\s'.,-]{2,50}?)(?:\s+via\b|\s*\d|\s*[-|/]|$)/i,
    );
    if (transferMatch?.[1]) {
      const name = transferMatch[1].replace(/[-,:;|]+$/, '').trim();
      if (name.length >= 3) return this.toTitleCase(name);
    }

    // Extract merchant from POS narrations
    const posMatch = text.match(
      /\bpos\s+(?:purchase|payment|debit)\s+(?:at|from|to|via)\s+([A-Za-z0-9][A-Za-z0-9\s&'.]{2,40}?)(?:\s+\w{2,3}$|\s*[-|/]|$)/i,
    );
    if (posMatch?.[1]) return this.toTitleCase(posMatch[1].trim());

    // Strip boilerplate stop-phrases
    const stopPhrases = [
      'If you experience any problems',
      'If you experience any problem',
      'Kindly contact us',
      'Please contact us',
      'For enquiries',
      'For more information',
      'Do not reply',
      'Do not respond',
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
      if (idx >= 0) text = text.slice(0, idx).trim();
    }

    text = text
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '')
      .replace(/^\d{12,}\s+/i, '')
      .replace(/\/TRF[\|][A-Z0-9|_-]+/gi, '')
      .replace(
        /\s+(?:Moniepoint(?:\s+MFB)?|OPay|PalmPay|Opay|First\s*Bank(?:\s+of\s+Nigeria)?|GTBank|Zenith(?:\s+Bank)?|Access(?:\s+Bank)?|UBA|Stanbic\s+IBTC(?:\s+Bank)?|Ecobank(?:\s+Nigeria)?|Fidelity(?:\s+Bank)?|Sterling(?:\s+Bank)?|Keystone(?:\s+Bank)?|Union(?:\s+Bank)?|Wema(?:\s+Bank)?)\s*\*+\d{2,}/gi,
        '',
      )
      .replace(/\s+\*{3,}\d{2,}/g, '')
      .replace(/\bHEAD OFFICE BRANCH\b[\s\S]*$/i, '')
      .replace(/\b(if\s+you\s+need\s+assistance|thank\s+you\s+for\s+banking|remember:)\b[\s\S]*$/i, '')
      .replace(/[-,:;|]+$/g, '')
      .trim();

    if (!text) return 'Unknown';
    const truncated = text.length > 80 ? text.slice(0, 80).trim() : text;
    // If the remaining text is all-uppercase (common in Nigerian bank emails), convert to title case.
    return truncated === truncated.toUpperCase() ? this.toTitleCase(truncated) : truncated;
  }

  private normalizeCurrency(currency: string | undefined): string | undefined {
    if (!currency) return undefined;
    const trimmed = currency.trim();
    const symbolMap: Record<string, string> = {
      '₦': 'NGN',
      'N': 'NGN',   // shorthand used by some Nigerian bank email templates
      '$': 'USD',
      '£': 'GBP',
      '€': 'EUR',
      '₵': 'GHS',
      'KSH': 'KES',
      'SH': 'KES',
      'R': 'ZAR',
    };
    if (symbolMap[trimmed]) return symbolMap[trimmed];
    const upper = trimmed.toUpperCase();
    // Accept only 3-letter ISO codes
    return /^[A-Z]{3}$/.test(upper) ? upper : undefined;
  }

  private toTitleCase(s: string): string {
    return s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
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

  private isLowQualityMerchant(merchant: string): boolean {
    const normalized = merchant.trim().toLowerCase();
    if (!normalized || normalized === 'unknown') return true;
    if (normalized.includes('head office branch')) return true;
    if (normalized === 'head office branch' || normalized === 'branch') return true;
    // Low-signal machine-ish values are usually parser noise.
    if (/^[a-f0-9-]{16,}$/i.test(normalized)) return true;
    return false;
  }

  /**
   * Repairs whichever regex-extracted fields turned out bad on an already-
   * successful template match, keeping the fields that were fine. One AI call
   * covers every field a message needs repaired - the caller decides which of
   * these to actually use, so a message needing both a merchant and a date
   * repair doesn't pay for two separate AI calls. Generalizes what was
   * previously merchant-only repair. See fintrack-backend#164.
   */
  private async repairFieldsWithAi(
    bankName: string,
    body: string,
    subject: string,
    categories: ICategory[],
    receivedAt: Date,
  ): Promise<{ merchant?: string; category?: string; date?: Date } | null> {
    // The transaction itself isn't at stake here - it already exists from the
    // regex match - so a rate limit just means "skip the repair," not "retry
    // the whole message."
    let extracted: ParsedTransaction | null;
    try {
      extracted = await this.parserRuleService.extractTransaction(bankName, body, subject, categories);
    } catch (err) {
      if (err instanceof RateLimitedExtractionError) return null;
      throw err;
    }
    if (!extracted) return null;

    const repairedMerchant = this.resolveMerchant(
      (extracted.merchant as string) || undefined,
      body,
      subject,
    );
    const repairedDate = this.parseDateCandidate(extracted.date);

    return {
      merchant: this.isLowQualityMerchant(repairedMerchant) ? undefined : repairedMerchant,
      category: extracted.category as string | undefined,
      date: repairedDate && this.isPlausibleTransactionDate(repairedDate, receivedAt) ? repairedDate : undefined,
    };
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

  private parsePositiveAmount(value: unknown): number | null {
    if (value == null) return null;
    if (typeof value === 'number') {
      if (!isFinite(value)) return null;
      const abs = Math.abs(value);
      return abs > 0 ? abs : null;
    }
    if (typeof value !== 'string') return null;

    const cleaned = value
      .replace(/,/g, '')
      .replace(/[^0-9.\-]/g, '')
      .trim();
    if (!cleaned) return null;

    const parsed = Number(cleaned);
    if (!isFinite(parsed)) return null;
    const abs = Math.abs(parsed);
    return abs > 0 ? abs : null;
  }

  private toSignedAmount(amount: number, transactionType: TransactionTypeEnum): number {
    if (!isFinite(amount) || amount === 0) return 0;
    const absAmount = Math.abs(amount);
    return transactionType === TransactionTypeEnum.DEBIT ? -absAmount : absAmount;
  }

  private isPlausibleTransactionDate(candidate: Date, receivedAt: Date): boolean {
    const toleranceMs = INGESTION_DATE_SANITY_TOLERANCE_DAYS * 24 * 60 * 60 * 1000;
    const diff = candidate.getTime() - receivedAt.getTime();
    return diff <= toleranceMs && diff >= -toleranceMs;
  }

  private resolveTransactionDate(value: string | undefined, body: string, subject: string, receivedAt: Date): Date {
    const primary = this.parseDateCandidate(value);
    if (primary && !this.isMidnight(primary, value) && this.isPlausibleTransactionDate(primary, receivedAt)) {
      return primary;
    }

    const combined = `${subject}\n${body}`;

    // 1. Labeled field (most reliable)
    const labeled = this.extractFieldValue(combined, [
      'transaction\\s+date\\s*&\\s*time',
      'time\\s+of\\s+transaction',
      'effective\\s+date',
      'date\\s+of\\s+transaction',
      'transaction\\s+date',
      'value\\s+date',
    ]);
    const labeledDate = this.parseDateCandidate(labeled);
    if (labeledDate && this.isPlausibleTransactionDate(labeledDate, receivedAt)) return labeledDate;

    // 2. Loose dd/mm/yyyy or dd-mm-yyyy with optional time
    const looseMatch = combined.match(
      /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\b/,
    )?.[0];
    const looseDate = this.parseDateCandidate(looseMatch);
    if (looseDate && this.isPlausibleTransactionDate(looseDate, receivedAt)) return looseDate;

    // 3. Compact date like "01Sep2025", "30Apr2026"
    const MON = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
    const compactMatch = combined.match(new RegExp(`\\b(\\d{1,2})(${MON})(\\d{4})\\b`, 'i'));
    if (compactMatch) {
      const compactDate = this.parseDateCandidate(`${compactMatch[1]} ${compactMatch[2]} ${compactMatch[3]}`);
      if (compactDate && this.isPlausibleTransactionDate(compactDate, receivedAt)) return compactDate;
    }

    // 4. Full ISO date embedded in text: YYYY-MM-DD
    const isoFullMatch = combined.match(/\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/)?.[0];
    const isoFullDate = this.parseDateCandidate(isoFullMatch);
    if (isoFullDate && this.isPlausibleTransactionDate(isoFullDate, receivedAt)) return isoFullDate;

    // 5. Year-month only: YYYY-MM (e.g. "Credit Interest for 2025-12") → last day of that month
    const yearMonthMatch = combined.match(/\b(20\d{2})-(0[1-9]|1[0-2])\b/);
    if (yearMonthMatch) {
      const year = Number(yearMonthMatch[1]);
      const month = Number(yearMonthMatch[2]);
      const yearMonthDate = new Date(year, month, 0); // day 0 of month+1 = last day of month
      if (this.isPlausibleTransactionDate(yearMonthDate, receivedAt)) return yearMonthDate;
    }

    // primary is revisited here (even though it may have already failed the
    // midnight/plausibility check above) as a last resort ahead of receivedAt -
    // but still has to pass the same plausibility check, since an implausible
    // date is worse than no date at all.
    if (primary && this.isPlausibleTransactionDate(primary, receivedAt)) return primary;
    // No plausible date found anywhere in the extracted text: fall back to the
    // email's own received timestamp (Gmail internalDate), not the moment we
    // happen to be processing it. For a backfill, "now" would silently mislabel
    // old transactions as happening today. See fintrack-backend#158.
    return receivedAt;
  }

  private parseDateCandidate(raw: string | undefined): Date | null {
    if (!raw) return null;
    const cleaned = raw.replace(/\./g, '').trim();
    if (!cleaned) return null;

    // Slash/dash-separated dates are ambiguous (dd/mm vs mm/dd), and Nigerian
    // bank alerts commonly use day-first. Try the explicit day-first parser
    // before the native Date constructor: native Date() happily parses e.g.
    // "04/05/2025" as April 5 (US month-first) instead of 4 May, and it never
    // gets a chance to be corrected below since a successful native parse used
    // to return immediately. Any day 1-12 was silently getting its day and
    // month swapped. See fintrack-backend#161.
    const slash = cleaned.match(
      /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
    );
    if (slash) {
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
      if (!isNaN(normalized.getTime())) return normalized;
    }

    const parsed = new Date(cleaned);
    return isNaN(parsed.getTime()) ? null : parsed;
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

  private async resolveCategory(
    merchant: string,
    _subject: string,
    body: string,
    categories: ICategory[],
    extractedCategory?: string,
    learnedCategory?: string | null,
  ): Promise<CategoryResolution> {
    if (learnedCategory) {
      return { category: learnedCategory, source: 'learned', verified: true };
    }

    const matchTarget = this.buildCategoryMatchTarget(merchant, body);
    const categoriesOrdered = this.orderCategoriesForRegex(categories);
    for (const cat of categoriesOrdered) {
      if (!cat.regex) continue;
      try {
        const pattern = new RegExp(cat.regex, 'i');
        if (pattern.test(matchTarget)) {
          return { category: cat.slug, source: 'regex_rule', matchedRule: cat.regex, verified: false };
        }
      } catch {
        // skip malformed regex
      }
    }

    if (extractedCategory) {
      const maybeSlug = this.normalizeKnownCategorySlug(extractedCategory, categories);
      if (maybeSlug) {
        return { category: maybeSlug, source: 'extracted', verified: false };
      }
    }

    const aiCategory = await this.parserRuleService.inferCategoryFromText(
      merchant,
      matchTarget,
      categories.map((c) => c.slug),
    );
    if (aiCategory) {
      return { category: aiCategory, source: 'ai_fallback', verified: false };
    }

    return { category: CategoryEnum.UNCATEGORIZED, source: 'default_uncategorized', verified: false };
  }

  private buildCategoryMatchTarget(merchant: string, body: string): string {
    const detail = this.extractFieldValue(body, [
      'description',
      'narration',
      'beneficiary\\s+name',
      'merchant',
      'payment\\s+to',
      'transfer\\s+to',
    ]);
    const merged = [merchant, detail]
      .filter((v) => !!v)
      .join(' ')
      .trim();
    return merged.toLowerCase();
  }

  private orderCategoriesForRegex(categories: ICategory[]): ICategory[] {
    const peerSlug = CategoryEnum.PEER_TO_PEER_TRANSFER;
    return [...categories].sort((a, b) => {
      if (a.slug === peerSlug && b.slug !== peerSlug) return 1;
      if (b.slug === peerSlug && a.slug !== peerSlug) return -1;
      return a.id - b.id;
    });
  }

  private normalizeKnownCategorySlug(slug: string, categories: ICategory[]): string | null {
    const normalized = slug.toLowerCase().trim();
    if (!normalized) return null;
    return categories.some((c) => c.slug === normalized) ? normalized : null;
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
    // Fall back to HTML, converted to readable text. html-to-text understands
    // block/table structure, so adjacent table cells in bank alert templates
    // stay separated instead of getting glued together (which broke label
    // matching in extractFieldValue downstream).
    const html = this.findMimePart(payload, 'text/html');
    if (html) {
      return convert(html, {
        wordwrap: false,
        selectors: [
          { selector: 'a', options: { ignoreHref: true } },
          { selector: 'img', format: 'skip' },
          // Default table handling collapses to a plain block with no cell
          // spacing — dataTable pads columns so adjacent cells (e.g. a label
          // cell next to its value cell) don't get glued together.
          { selector: 'table', format: 'dataTable' },
        ],
      });
    }
    return '';
  }

  /** Content-Type's charset param for a MIME part, e.g. 'iso-8859-1'. Defaults to utf-8. */
  private extractCharset(part: any): string {
    const headers: { name?: string; value?: string }[] = part?.headers || [];
    const contentType =
      headers.find((h) => (h.name || '').toLowerCase() === 'content-type')?.value || '';
    const match = contentType.match(/charset=["']?([^;"'\s]+)/i);
    return (match ? match[1] : 'utf-8').toLowerCase();
  }

  private findMimePart(payload: any, mimeType: string): string {
    if (!payload) return '';
    if (payload.mimeType === mimeType && payload.body?.data) {
      const buffer = Buffer.from(payload.body.data, 'base64');
      const charset = this.extractCharset(payload);
      if (charset !== 'utf-8' && charset !== 'utf8' && charset !== 'us-ascii' && iconv.encodingExists(charset)) {
        return iconv.decode(buffer, charset);
      }
      return buffer.toString('utf8');
    }
    if (payload.parts) {
      for (const part of payload.parts) {
        const result = this.findMimePart(part, mimeType);
        if (result) return result;
      }
    }
    return '';
  }

  /**
   * Runs AI extraction on a sample of production-template matches and compares
   * fields against the regex result. recordFailure only fires today on an
   * unparseable amount or a low-quality merchant - a wrong-but-well-formed
   * field (a bad amount, a wrong date, a plausible-but-incorrect merchant)
   * currently has no way to be caught. A divergence here records a failure the
   * same way, feeding the existing confidence-score/demotion machinery instead
   * of duplicating it. Runs off the critical path - the transaction from the
   * regex match is already created by the time this fires. See
   * fintrack-backend#163.
   */
  private async shadowVerifyTemplateMatch(
    templateId: number,
    bankName: string,
    emailBody: string,
    emailSubject: string,
    regexResult: ParsedTransaction,
    receivedAt: Date,
    dbCategories: ICategory[],
  ): Promise<void> {
    let aiResult: ParsedTransaction | null;
    try {
      aiResult = await this.parserRuleService.extractTransaction(bankName, emailBody, emailSubject, dbCategories);
    } catch (err) {
      if (err instanceof RateLimitedExtractionError) return;
      logger.error(`[ShadowVerify] AI extraction failed for template ${templateId} - ${err}`);
      return;
    }
    // A null AI result (genuinely judged not a transaction, or a parse miss)
    // isn't a strong enough signal either way - skip rather than penalize.
    if (!aiResult) return;

    const regexAmount = this.parsePositiveAmount(regexResult.amount);
    const aiAmount = this.parsePositiveAmount(aiResult.amount);
    const amountDiverges = regexAmount == null || aiAmount == null || Math.abs(regexAmount - aiAmount) > 0.01;

    const typeDiverges =
      this.normalizeTransactionType(regexResult.transactionType) !==
      this.normalizeTransactionType(aiResult.transactionType);

    const regexDate = this.resolveTransactionDate(regexResult.date, emailBody, emailSubject, receivedAt);
    const aiDate = this.resolveTransactionDate(aiResult.date, emailBody, emailSubject, receivedAt);
    const dateDiverges = regexDate.toDateString() !== aiDate.toDateString();

    const regexMerchant = this.normalizeMerchantForComparison(regexResult.merchant as string | undefined);
    const aiMerchant = this.normalizeMerchantForComparison(aiResult.merchant as string | undefined);
    const merchantDiverges =
      !!regexMerchant && !!aiMerchant && !regexMerchant.includes(aiMerchant) && !aiMerchant.includes(regexMerchant);

    if (amountDiverges || typeDiverges || dateDiverges || merchantDiverges) {
      logger.warn(
        `[ShadowVerify] Divergence for template ${templateId}: amount=${amountDiverges} type=${typeDiverges} date=${dateDiverges} merchant=${merchantDiverges}`,
      );
      await this.parserRuleService.recordFailure(templateId);
    }
  }

  // Loose equality for merchant names extracted two different ways (regex vs
  // AI) - strips everything but alphanumerics so "Jumia Nigeria" and "JUMIA"
  // compare as related without needing real fuzzy matching.
  private normalizeMerchantForComparison(value: string | undefined): string {
    return (value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  private scheduleTemplateGeneration(
    bankId: number,
    emailBody: string,
    emailSubject: string,
    senderConfidence?: BankIdentificationSource,
  ): void {
    const formatSignature = this.parserRuleService.computeFormatSignature(emailSubject, emailBody);
    const guardKey = `${bankId}:${formatSignature}`;

    const now = Date.now();
    const cooldownUntil = this.templateGenerationCooldownUntil.get(guardKey) || 0;
    if (this.templateGenerationInFlight.has(guardKey) || cooldownUntil > now) {
      return;
    }

    this.templateGenerationInFlight.add(guardKey);
    setImmediate(() => {
      this.parserRuleService
        .hasExistingTemplate(bankId, emailSubject, emailBody)
        .then((exists) => {
          if (exists) {
            // A prior attempt already created a template for this bank AND this
            // email format (candidate, audited, production, or failed_audit) — a
            // burst of further same-format emails during a backfill shouldn't
            // each mint their own near-duplicate template. Manual regeneration
            // (e.g. the admin "Generate" action) can still create a new one
            // intentionally; this only guards the automatic per-email trigger.
            // Scoped per format, not per bank, so a bank's other email shapes
            // still each get their own generation attempt. See
            // fintrack-backend#140, fintrack-backend#160.
            return null;
          }
          return this.parserRuleService
            .generateTemplate(bankId, emailBody, emailSubject)
            .then((template) => this.parserRuleService.auditTemplate(template.id, senderConfidence));
        })
        .then(() => {
          this.templateGenerationCooldownUntil.delete(guardKey);
        })
        .catch((err) => {
          if (this.isRateLimitError(err)) {
            this.templateGenerationCooldownUntil.set(guardKey, Date.now() + TEMPLATE_RETRY_COOLDOWN_MS);
            logger.warn(
              `Template generation rate-limited for bank ${bankId} (format ${formatSignature}); pausing retries for ${TEMPLATE_RETRY_COOLDOWN_MS / 1000}s`,
            );
            return;
          }
          logger.error(`Background template generation failed for bank ${bankId} (format ${formatSignature}) - ${err}`);
        })
        .finally(() => {
          this.templateGenerationInFlight.delete(guardKey);
        });
    });
  }

  private isRateLimitError(error: unknown): boolean {
    const e = error as { status?: number; message?: string };
    return e?.status === 429 || (e?.message || '').includes('429');
  }
}

export default IngestionService;
