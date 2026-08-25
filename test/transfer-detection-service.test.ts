import 'reflect-metadata';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import TransferDetectionService from '../src/modules/account/transfer-detection.service';
import { ITransactionRepository } from '../src/modules/transaction/transaction.repository';
import { ITransaction } from '../src/modules/transaction/transaction.interface';
import { TransactionTypeEnum, TransactionStatusEnum, CategoryEnum } from '../src/modules/transaction/transaction.enum';
import { ITransferLinkRepository } from '../src/modules/account/transfer-link.repository';
import { ITransferLink } from '../src/modules/account/transfer-link.interface';
import { IExchangeRateService } from '../src/modules/exchange-rate/exchange-rate.service';

let nextTxnId = 1;

function makeTransaction(overrides: Partial<ITransaction> & { userId: number; accountId: number | null }): ITransaction {
  return {
    id: nextTxnId++,
    emailConnectionId: null,
    bankId: 1,
    parserTemplateId: null,
    gmailMessageId: null,
    merchant: 'Test Merchant',
    category: CategoryEnum.UNCATEGORIZED,
    transactionType: TransactionTypeEnum.DEBIT,
    amount: -1000,
    currency: 'NGN',
    refAmount: 1000,
    refCurrency: 'NGN',
    exchangeRateUsed: 1,
    transactionDate: new Date('2026-01-01T12:00:00Z'),
    status: TransactionStatusEnum.UNVERIFIED,
    originalMerchant: null,
    originalCategory: null,
    reference: null,
    balance: null,
    excludeFromTotals: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

class FakeTransactionRepository
  implements Pick<ITransactionRepository, 'findTransferCandidates' | 'markExcludedFromTotals' | 'findUnexcludedForUser'>
{
  // Used directly by the detectForTransaction tests below.
  candidates: ITransaction[] = [];
  excludedIds: number[] = [];
  // Used by the rescanForUser tests: a shared pool that findTransferCandidates and
  // findUnexcludedForUser both search live against, mirroring the real DB filter.
  store: ITransaction[] = [];

  async findTransferCandidates(input: {
    excludeTransactionId: number;
    excludeAccountId: number;
    transactionType: string;
  }): Promise<ITransaction[]> {
    if (this.store.length === 0) return this.candidates;
    return this.store.filter(
      (t) =>
        t.id !== input.excludeTransactionId &&
        t.accountId !== input.excludeAccountId &&
        t.transactionType === input.transactionType &&
        !t.excludeFromTotals,
    );
  }

  async markExcludedFromTotals(ids: number[]): Promise<void> {
    this.excludedIds.push(...ids);
    for (const t of this.store) if (ids.includes(t.id)) t.excludeFromTotals = true;
  }

  async findUnexcludedForUser(): Promise<ITransaction[]> {
    return this.store.filter((t) => !t.excludeFromTotals);
  }
}

class FakeTransferLinkRepository implements ITransferLinkRepository {
  links: ITransferLink[] = [];
  private nextId = 1;

  async create(data: {
    userId: number;
    fromTransactionId: number | null;
    toTransactionId: number | null;
    linkType: string;
    confidence: string;
  }): Promise<ITransferLink> {
    const link: ITransferLink = { id: this.nextId++, createdAt: new Date(), ...data };
    this.links.push(link);
    return link;
  }

  async findByTransactionId(transactionId: number): Promise<ITransferLink | null> {
    return (
      this.links.find((l) => l.fromTransactionId === transactionId || l.toTransactionId === transactionId) ?? null
    );
  }

  async delete(id: number): Promise<void> {
    this.links = this.links.filter((l) => l.id !== id);
  }
}

class FakeExchangeRateService implements Pick<IExchangeRateService, 'getRate'> {
  constructor(private rate: number) {}
  async getRate(): Promise<number> {
    return this.rate;
  }
}

function setup(marketRate = 1) {
  const transactionRepository = new FakeTransactionRepository();
  const transferLinkRepository = new FakeTransferLinkRepository();
  const exchangeRateService = new FakeExchangeRateService(marketRate) as unknown as IExchangeRateService;
  const service = new TransferDetectionService(
    transactionRepository as unknown as ITransactionRepository,
    transferLinkRepository,
    exchangeRateService,
  );
  return { transactionRepository, transferLinkRepository, service };
}

describe('TransferDetectionService.detectForTransaction', () => {
  test('links a same-currency, exact-amount match as internal_transfer/auto_high', async () => {
    const { transactionRepository, transferLinkRepository, service } = setup();
    const debit = makeTransaction({ userId: 1, accountId: 1, amount: -1000, transactionType: TransactionTypeEnum.DEBIT });
    const credit = makeTransaction({ userId: 1, accountId: 2, amount: 1000, transactionType: TransactionTypeEnum.CREDIT });
    transactionRepository.candidates = [credit];

    await service.detectForTransaction(debit);

    assert.equal(transferLinkRepository.links.length, 1);
    assert.equal(transferLinkRepository.links[0].userId, 1);
    assert.equal(transferLinkRepository.links[0].fromTransactionId, debit.id);
    assert.equal(transferLinkRepository.links[0].toTransactionId, credit.id);
    assert.equal(transferLinkRepository.links[0].linkType, 'internal_transfer');
    assert.equal(transferLinkRepository.links[0].confidence, 'auto_high');
    assert.deepEqual(transactionRepository.excludedIds.sort(), [debit.id, credit.id].sort());
  });

  test('links a cross-currency match within FX tolerance as currency_conversion/auto_low', async () => {
    const { transactionRepository, transferLinkRepository, service } = setup(1600);
    const debit = makeTransaction({
      userId: 1,
      accountId: 1,
      currency: 'USD',
      amount: -100,
      transactionType: TransactionTypeEnum.DEBIT,
    });
    const credit = makeTransaction({
      userId: 1,
      accountId: 2,
      currency: 'NGN',
      amount: 159000, // implied rate 1590, within 3% of 1600
      transactionType: TransactionTypeEnum.CREDIT,
    });
    transactionRepository.candidates = [credit];

    await service.detectForTransaction(debit);

    assert.equal(transferLinkRepository.links.length, 1);
    assert.equal(transferLinkRepository.links[0].linkType, 'currency_conversion');
    assert.equal(transferLinkRepository.links[0].confidence, 'auto_low');
    assert.equal(transferLinkRepository.links[0].fromTransactionId, debit.id);
    assert.equal(transferLinkRepository.links[0].toTransactionId, credit.id);
  });

  test('does not match a cross-currency candidate outside FX tolerance', async () => {
    const { transactionRepository, transferLinkRepository, service } = setup(1600);
    const debit = makeTransaction({ userId: 1, accountId: 1, currency: 'USD', amount: -100, transactionType: TransactionTypeEnum.DEBIT });
    const credit = makeTransaction({
      userId: 1,
      accountId: 2,
      currency: 'NGN',
      amount: 100000, // implied rate 1000, way outside 3% of 1600
      transactionType: TransactionTypeEnum.CREDIT,
    });
    transactionRepository.candidates = [credit];

    await service.detectForTransaction(debit);

    assert.equal(transferLinkRepository.links.length, 0);
    assert.equal(transactionRepository.excludedIds.length, 0);
  });

  test('excludes an unmatched currency_conversion leg alone, at auto_low, unlinked', async () => {
    const { transactionRepository, transferLinkRepository, service } = setup();
    const debit = makeTransaction({
      userId: 1,
      accountId: 1,
      category: CategoryEnum.CURRENCY_CONVERSION,
      transactionType: TransactionTypeEnum.DEBIT,
    });
    transactionRepository.candidates = [];

    await service.detectForTransaction(debit);

    assert.equal(transferLinkRepository.links.length, 1);
    assert.equal(transferLinkRepository.links[0].userId, 1);
    assert.equal(transferLinkRepository.links[0].fromTransactionId, debit.id);
    assert.equal(transferLinkRepository.links[0].toTransactionId, null);
    assert.equal(transferLinkRepository.links[0].linkType, 'currency_conversion');
    assert.equal(transferLinkRepository.links[0].confidence, 'auto_low');
    assert.deepEqual(transactionRepository.excludedIds, [debit.id]);
  });

  test('leaves an unmatched peer_to_peer_transfer alone', async () => {
    const { transactionRepository, transferLinkRepository, service } = setup();
    const debit = makeTransaction({
      userId: 1,
      accountId: 1,
      category: CategoryEnum.PEER_TO_PEER_TRANSFER,
      transactionType: TransactionTypeEnum.DEBIT,
    });
    transactionRepository.candidates = [];

    await service.detectForTransaction(debit);

    assert.equal(transferLinkRepository.links.length, 0);
    assert.equal(transactionRepository.excludedIds.length, 0);
  });

  test('skips transactions with no resolved account', async () => {
    const { transferLinkRepository, service } = setup();
    const debit = makeTransaction({ userId: 1, accountId: null, category: CategoryEnum.CURRENCY_CONVERSION });

    await service.detectForTransaction(debit);

    assert.equal(transferLinkRepository.links.length, 0);
  });
});

describe('TransferDetectionService.rescanForUser', () => {
  test('links matching pairs and single-leg conversions across full history in one pass', async () => {
    const { transactionRepository, service } = setup();
    const pairDebit = makeTransaction({
      userId: 1,
      accountId: 1,
      amount: -1000,
      transactionType: TransactionTypeEnum.DEBIT,
      transactionDate: new Date('2026-01-01T00:00:00Z'),
    });
    const pairCredit = makeTransaction({
      userId: 1,
      accountId: 2,
      amount: 1000,
      transactionType: TransactionTypeEnum.CREDIT,
      transactionDate: new Date('2026-01-01T00:10:00Z'),
    });
    const unmatchedConversion = makeTransaction({
      userId: 1,
      accountId: 1,
      category: CategoryEnum.CURRENCY_CONVERSION,
      transactionType: TransactionTypeEnum.DEBIT,
      transactionDate: new Date('2026-01-02T00:00:00Z'),
    });
    const untouched = makeTransaction({
      userId: 1,
      accountId: 1,
      category: CategoryEnum.UNCATEGORIZED,
      transactionType: TransactionTypeEnum.DEBIT,
      transactionDate: new Date('2026-01-03T00:00:00Z'),
    });
    transactionRepository.store = [pairDebit, pairCredit, unmatchedConversion, untouched];

    const result = await service.rescanForUser(1);

    // pairCredit is claimed by pairDebit's match and never separately scanned.
    assert.deepEqual(result, { scanned: 3, linked: 2 });
    assert.equal(pairDebit.excludeFromTotals, true);
    assert.equal(pairCredit.excludeFromTotals, true);
    assert.equal(unmatchedConversion.excludeFromTotals, true);
    assert.equal(untouched.excludeFromTotals, false);
  });

  test('is idempotent: a second rescan over already-linked history does nothing further', async () => {
    const { transactionRepository, service } = setup();
    const debit = makeTransaction({
      userId: 1,
      accountId: 1,
      amount: -1000,
      transactionType: TransactionTypeEnum.DEBIT,
      transactionDate: new Date('2026-01-01T00:00:00Z'),
    });
    const credit = makeTransaction({
      userId: 1,
      accountId: 2,
      amount: 1000,
      transactionType: TransactionTypeEnum.CREDIT,
      transactionDate: new Date('2026-01-01T00:10:00Z'),
    });
    transactionRepository.store = [debit, credit];

    const first = await service.rescanForUser(1);
    assert.deepEqual(first, { scanned: 1, linked: 1 });

    const second = await service.rescanForUser(1);
    assert.deepEqual(second, { scanned: 0, linked: 0 });
  });
});
