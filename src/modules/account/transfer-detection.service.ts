import { inject, injectable } from 'tsyringe';
import { ITransactionRepository } from '@/modules/transaction/transaction.repository';
import { ITransaction } from '@/modules/transaction/transaction.interface';
import { TransactionTypeEnum, CategoryEnum } from '@/modules/transaction/transaction.enum';
import { IExchangeRateService } from '@/modules/exchange-rate/exchange-rate.service';
import { ITransferLinkRepository } from './transfer-link.repository';
import { IAccountTransferRuleRepository } from './account-transfer-rule.repository';
import { TransferRuleDecision } from './account-transfer-rule.interface';
import { InternalServerException } from '@/common/exception';
import logger from '@/common/lib/logger';

// Narration words that carry no identifying signal — stripped before
// comparing two legs' merchant text for a shared counterparty name.
const NARRATION_STOPWORDS = new Set([
  'trf',
  'trm',
  'transfer',
  'to',
  'from',
  'via',
  'alert',
  'debit',
  'credit',
  'ngn',
  'usd',
  'gbp',
  'eur',
  'the',
  'a',
  'of',
]);

// How far apart two legs of the same transfer can be, since alert delivery timing varies by bank.
const MATCH_WINDOW_MS = 60 * 60 * 1000;
// How far the implied cross-currency rate may drift from the current market rate and still count as a match.
const FX_TOLERANCE = 0.03;
// Wider tolerance for an account pair the user has already confirmed is a real
// transfer route — a consistently-used conversion path can sit further from
// the market rate (a poor in-app rate, a recurring fee) without being wrong.
const RULE_TRUSTED_FX_TOLERANCE = 0.08;
// Floating-point/rounding slack when comparing two same-currency amounts.
const AMOUNT_EPSILON = 0.01;

export interface ITransferDetectionService {
  /**
   * Runs right after a transaction is persisted: looks for the opposite leg
   * of a self-transfer or currency conversion among the user's own accounts,
   * and excludes matched (or independently currency_conversion-categorized)
   * legs from spend/income totals.
   */
  detectForTransaction(transaction: ITransaction): Promise<void>;
  /**
   * BE-1.8: idempotent, on-demand "re-scan my transactions for transfers" over a
   * user's full existing history. Not run automatically during the BE-1.1 migration
   * or the BE-1.2 account backfill — too expensive/risky at scale to do unconditionally,
   * so it's a Settings action the user (or an admin, on their behalf) triggers once.
   */
  rescanForUser(userId: number): Promise<{ scanned: number; linked: number }>;
  /**
   * Persists the user's explicit "always/never treat transfers between these
   * two accounts this way" decision, so future transactions on this specific
   * pair skip the amount/FX guesswork (or are never flagged at all).
   */
  rememberDecision(userId: number, accountAId: number, accountBId: number, decision: TransferRuleDecision): Promise<void>;
}

@injectable()
class TransferDetectionService implements ITransferDetectionService {
  constructor(
    @inject('ITransactionRepository') private transactionRepository: ITransactionRepository,
    @inject('ITransferLinkRepository') private transferLinkRepository: ITransferLinkRepository,
    @inject('IExchangeRateService') private exchangeRateService: IExchangeRateService,
    @inject('IAccountTransferRuleRepository') private ruleRepository: IAccountTransferRuleRepository,
  ) {}

  async detectForTransaction(transaction: ITransaction): Promise<void> {
    try {
      // Can't tell "different account" from "unattributable" without a resolved account.
      if (transaction.accountId == null || transaction.amount === 0) return;

      const match = await this.findMatch(transaction);
      if (match) {
        await this.linkPair(transaction, match.candidate, match.confidence);
        return;
      }

      // No paired leg — still worth excluding on its own if it's independently
      // categorized as a conversion. Never do this for peer_to_peer_transfer:
      // that's real spend unless it matched another of the user's own accounts above.
      if (transaction.category === CategoryEnum.CURRENCY_CONVERSION) {
        await this.excludeSingleLeg(transaction);
      }
    } catch (error) {
      logger.error(`[TransferDetection] Error detecting transfer for transaction ${transaction.id} - ${error}`);
    }
  }

  private async findMatch(transaction: ITransaction): Promise<{ candidate: ITransaction; confidence: string } | null> {
    const oppositeType =
      transaction.transactionType === TransactionTypeEnum.DEBIT ? TransactionTypeEnum.CREDIT : TransactionTypeEnum.DEBIT;

    const candidates = await this.transactionRepository.findTransferCandidates({
      userId: transaction.userId,
      excludeTransactionId: transaction.id,
      excludeAccountId: transaction.accountId as number,
      transactionType: oppositeType,
      windowStart: new Date(transaction.transactionDate.getTime() - MATCH_WINDOW_MS),
      windowEnd: new Date(transaction.transactionDate.getTime() + MATCH_WINDOW_MS),
    });

    // First structurally- and amount-valid candidate wins; two genuine self-transfers
    // landing in the same ~2hr window for one user is rare enough not to rank these.
    for (const candidate of candidates) {
      const rule =
        candidate.accountId != null
          ? await this.ruleRepository.findForPair(transaction.userId, transaction.accountId as number, candidate.accountId)
          : null;
      // The user has already told us money never crosses between these two
      // accounts as a transfer — don't second-guess that with a coincidental
      // amount/FX match.
      if (rule?.decision === 'never_transfer') continue;
      const isTrustedPair = rule?.decision === 'always_transfer';

      if (candidate.currency === transaction.currency) {
        if (Math.abs(Math.abs(candidate.amount) - Math.abs(transaction.amount)) <= AMOUNT_EPSILON) {
          return { candidate, confidence: isTrustedPair ? 'rule_based' : 'auto_high' };
        }
        continue;
      }

      const tolerance = isTrustedPair ? RULE_TRUSTED_FX_TOLERANCE : FX_TOLERANCE;
      const isFxMatch = await this.isWithinFxTolerance(transaction, candidate, tolerance);
      if (isFxMatch) {
        if (isTrustedPair) {
          return { candidate, confidence: 'rule_based' };
        }
        // Both legs' narrations naming the same counterparty (e.g. "TRF ...
        // JANE DOE" on one side, "TRF FROM JANE DOE" on the other) is a
        // strong signal this is really a self-transfer, not a coincidental
        // FX-tolerance match against an unrelated transaction.
        const namesMatch = this.merchantNamesOverlap(transaction.merchant, candidate.merchant);
        return { candidate, confidence: namesMatch ? 'auto_high' : 'auto_low' };
      }
    }

    return null;
  }

  private async isWithinFxTolerance(a: ITransaction, b: ITransaction, tolerance: number): Promise<boolean> {
    const debit = a.transactionType === TransactionTypeEnum.DEBIT ? a : b;
    const credit = debit === a ? b : a;

    const marketRate = await this.exchangeRateService.getRate(debit.currency, credit.currency);
    if (!(marketRate > 0)) return false;

    const impliedRate = Math.abs(credit.amount) / Math.abs(debit.amount);
    const deviation = Math.abs(impliedRate - marketRate) / marketRate;
    return deviation <= tolerance;
  }

  /** True if the two legs' narrations share a meaningful word (e.g. a counterparty name) once common banking/currency terms are stripped out. */
  private merchantNamesOverlap(merchantA: string, merchantB: string): boolean {
    const tokenize = (text: string): Set<string> =>
      new Set(
        text
          .toLowerCase()
          .replace(/[^a-z\s]/g, ' ')
          .split(/\s+/)
          .filter((token) => token.length >= 3 && !NARRATION_STOPWORDS.has(token)),
      );

    const tokensA = tokenize(merchantA);
    const tokensB = tokenize(merchantB);
    for (const token of tokensB) {
      if (tokensA.has(token)) return true;
    }
    return false;
  }

  private async linkPair(transaction: ITransaction, candidate: ITransaction, confidence: string): Promise<void> {
    const debit = transaction.transactionType === TransactionTypeEnum.DEBIT ? transaction : candidate;
    const credit = debit === transaction ? candidate : transaction;
    const linkType = transaction.currency === candidate.currency ? 'internal_transfer' : 'currency_conversion';

    await this.transferLinkRepository.create({
      userId: transaction.userId,
      fromTransactionId: debit.id,
      toTransactionId: credit.id,
      linkType,
      confidence,
    });
    await this.transactionRepository.markExcludedFromTotals([transaction.id, candidate.id]);
    logger.info(`[TransferDetection] Linked transactions ${debit.id} <-> ${credit.id} (${linkType}, ${confidence})`);
  }

  private async excludeSingleLeg(transaction: ITransaction): Promise<void> {
    const isDebit = transaction.transactionType === TransactionTypeEnum.DEBIT;

    await this.transferLinkRepository.create({
      userId: transaction.userId,
      fromTransactionId: isDebit ? transaction.id : null,
      toTransactionId: isDebit ? null : transaction.id,
      linkType: 'currency_conversion',
      confidence: 'auto_low',
    });
    await this.transactionRepository.markExcludedFromTotals([transaction.id]);
    logger.info(`[TransferDetection] Excluded unlinked currency_conversion leg ${transaction.id}`);
  }

  async rescanForUser(userId: number): Promise<{ scanned: number; linked: number }> {
    try {
      const transactions = await this.transactionRepository.findUnexcludedForUser(userId);

      // A match excludes both legs; skip a later transaction in this same pass once
      // an earlier one has already claimed it, so re-running this stays idempotent.
      const claimed = new Set<number>();
      let scanned = 0;
      let linked = 0;

      for (const transaction of transactions) {
        if (claimed.has(transaction.id)) continue;
        scanned++;

        await this.detectForTransaction(transaction);

        const link = await this.transferLinkRepository.findByTransactionId(transaction.id);
        if (link) {
          linked++;
          if (link.fromTransactionId !== null) claimed.add(link.fromTransactionId);
          if (link.toTransactionId !== null) claimed.add(link.toTransactionId);
        }
      }

      logger.info(`[TransferDetection] Rescan complete for user ${userId}: ${scanned} scanned, ${linked} linked`);
      return { scanned, linked };
    } catch (error) {
      logger.error(`[TransferDetection] Rescan failed for user ${userId} - ${error}`);
      throw new InternalServerException('Failed to rescan transactions for transfers');
    }
  }

  async rememberDecision(
    userId: number,
    accountAId: number,
    accountBId: number,
    decision: TransferRuleDecision,
  ): Promise<void> {
    await this.ruleRepository.upsert(userId, accountAId, accountBId, decision);
    logger.info(
      `[TransferDetection] Remembered "${decision}" for account pair (${accountAId}, ${accountBId}), user ${userId}`,
    );
  }
}

export default TransferDetectionService;
