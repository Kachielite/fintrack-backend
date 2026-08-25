import { inject, injectable } from 'tsyringe';
import { ITransactionRepository } from '@/modules/transaction/transaction.repository';
import { ITransaction } from '@/modules/transaction/transaction.interface';
import { TransactionTypeEnum, CategoryEnum } from '@/modules/transaction/transaction.enum';
import { IExchangeRateService } from '@/modules/exchange-rate/exchange-rate.service';
import { ITransferLinkRepository } from './transfer-link.repository';
import { InternalServerException } from '@/common/exception';
import logger from '@/common/lib/logger';

// How far apart two legs of the same transfer can be, since alert delivery timing varies by bank.
const MATCH_WINDOW_MS = 60 * 60 * 1000;
// How far the implied cross-currency rate may drift from the current market rate and still count as a match.
const FX_TOLERANCE = 0.03;
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
}

@injectable()
class TransferDetectionService implements ITransferDetectionService {
  constructor(
    @inject('ITransactionRepository') private transactionRepository: ITransactionRepository,
    @inject('ITransferLinkRepository') private transferLinkRepository: ITransferLinkRepository,
    @inject('IExchangeRateService') private exchangeRateService: IExchangeRateService,
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
      if (candidate.currency === transaction.currency) {
        if (Math.abs(Math.abs(candidate.amount) - Math.abs(transaction.amount)) <= AMOUNT_EPSILON) {
          return { candidate, confidence: 'auto_high' };
        }
        continue;
      }

      const isFxMatch = await this.isWithinFxTolerance(transaction, candidate);
      if (isFxMatch) {
        return { candidate, confidence: 'auto_low' };
      }
    }

    return null;
  }

  private async isWithinFxTolerance(a: ITransaction, b: ITransaction): Promise<boolean> {
    const debit = a.transactionType === TransactionTypeEnum.DEBIT ? a : b;
    const credit = debit === a ? b : a;

    const marketRate = await this.exchangeRateService.getRate(debit.currency, credit.currency);
    if (!(marketRate > 0)) return false;

    const impliedRate = Math.abs(credit.amount) / Math.abs(debit.amount);
    const deviation = Math.abs(impliedRate - marketRate) / marketRate;
    return deviation <= FX_TOLERANCE;
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
}

export default TransferDetectionService;
