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
import { IAccountTransferRuleRepository } from '../src/modules/account/account-transfer-rule.repository';
import { IAccountTransferRule, TransferRuleDecision } from '../src/modules/account/account-transfer-rule.interface';

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
  implements
    Pick<ITransactionRepository, 'findTransferCandidates' | 'markExcludedFromTotals' | 'findUnexcludedForUser' | 'update'>
{
  // Used directly by the detectForTransaction tests below.
  candidates: ITransaction[] = [];
  excludedIds: number[] = [];
  // Records every update() call — the transaction passed into detectForTransaction
  // is a bare object, not something registered in `store`/`candidates`, so this is
  // the only way tests can assert what category a leg was relabeled to.
  updates: { id: number; data: Partial<ITransaction> }[] = [];
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

  async update(id: number, userId: number, data: Partial<ITransaction>): Promise<ITransaction> {
    this.updates.push({ id, data });
    const applyTo = (t: ITransaction) => Object.assign(t, data);
    const target =
      this.store.find((t) => t.id === id && t.userId === userId) ??
      this.candidates.find((t) => t.id === id && t.userId === userId);
    if (target) applyTo(target);
    return (target ?? ({ id, userId, ...data } as ITransaction)) as ITransaction;
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

class FakeAccountTransferRuleRepository implements IAccountTransferRuleRepository {
  rules: IAccountTransferRule[] = [];
  private nextId = 1;

  async findForPair(userId: number, accountAId: number, accountBId: number): Promise<IAccountTransferRule | null> {
    const [lo, hi] = accountAId < accountBId ? [accountAId, accountBId] : [accountBId, accountAId];
    return (
      this.rules.find((r) => r.userId === userId && r.accountAId === lo && r.accountBId === hi) ?? null
    );
  }

  async upsert(
    userId: number,
    accountAId: number,
    accountBId: number,
    decision: TransferRuleDecision,
  ): Promise<IAccountTransferRule> {
    const [lo, hi] = accountAId < accountBId ? [accountAId, accountBId] : [accountBId, accountAId];
    const existing = await this.findForPair(userId, lo, hi);
    if (existing) {
      existing.decision = decision;
      existing.updatedAt = new Date();
      return existing;
    }
    const rule: IAccountTransferRule = {
      id: this.nextId++,
      userId,
      accountAId: lo,
      accountBId: hi,
      decision,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.rules.push(rule);
    return rule;
  }
}

function setup(marketRate = 1) {
  const transactionRepository = new FakeTransactionRepository();
  const transferLinkRepository = new FakeTransferLinkRepository();
  const exchangeRateService = new FakeExchangeRateService(marketRate) as unknown as IExchangeRateService;
  const ruleRepository = new FakeAccountTransferRuleRepository();
  const service = new TransferDetectionService(
    transactionRepository as unknown as ITransactionRepository,
    transferLinkRepository,
    exchangeRateService,
    ruleRepository,
  );
  return { transactionRepository, transferLinkRepository, ruleRepository, service };
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
    assert.deepEqual(
      transactionRepository.updates.map((u) => u.data.category).sort(),
      [CategoryEnum.SELF_TRANSFER, CategoryEnum.SELF_TRANSFER],
    );
  });

  test('links a cross-currency match within FX tolerance as currency_conversion/auto_low when narrations share no name', async () => {
    const { transactionRepository, transferLinkRepository, service } = setup(1600);
    const debit = makeTransaction({
      userId: 1,
      accountId: 1,
      currency: 'USD',
      amount: -100,
      merchant: 'FX Conversion',
      transactionType: TransactionTypeEnum.DEBIT,
    });
    const credit = makeTransaction({
      userId: 1,
      accountId: 2,
      currency: 'NGN',
      amount: 159000, // implied rate 1590, within 3% of 1600
      merchant: 'Wallet Funding',
      transactionType: TransactionTypeEnum.CREDIT,
    });
    transactionRepository.candidates = [credit];

    await service.detectForTransaction(debit);

    assert.equal(transferLinkRepository.links.length, 1);
    assert.equal(transferLinkRepository.links[0].linkType, 'currency_conversion');
    assert.equal(transferLinkRepository.links[0].confidence, 'auto_low');
    assert.equal(transferLinkRepository.links[0].fromTransactionId, debit.id);
    assert.equal(transferLinkRepository.links[0].toTransactionId, credit.id);
    // Category is always self_transfer once matched, regardless of currency —
    // linkType (currency_conversion, asserted above) stays the technical record
    // of what actually happened, but the user-facing category is unified.
    assert.deepEqual(
      transactionRepository.updates.map((u) => u.data.category).sort(),
      [CategoryEnum.SELF_TRANSFER, CategoryEnum.SELF_TRANSFER],
    );
  });

  test('upgrades a cross-currency FX-tolerance match to auto_high when both narrations name the same counterparty', async () => {
    const { transactionRepository, transferLinkRepository, service } = setup(1600);
    const debit = makeTransaction({
      userId: 1,
      accountId: 1,
      currency: 'USD',
      amount: -100,
      merchant: 'TRF TO JANE DOE',
      transactionType: TransactionTypeEnum.DEBIT,
    });
    const credit = makeTransaction({
      userId: 1,
      accountId: 2,
      currency: 'NGN',
      amount: 159000,
      merchant: 'TRF FROM JANE DOE',
      transactionType: TransactionTypeEnum.CREDIT,
    });
    transactionRepository.candidates = [credit];

    await service.detectForTransaction(debit);

    assert.equal(transferLinkRepository.links.length, 1);
    assert.equal(transferLinkRepository.links[0].confidence, 'auto_high');
  });

  test('never_transfer rule blocks a match even when amount/FX would otherwise qualify', async () => {
    const { transactionRepository, transferLinkRepository, ruleRepository, service } = setup();
    ruleRepository.rules.push({
      id: 1,
      userId: 1,
      accountAId: 1,
      accountBId: 2,
      decision: 'never_transfer',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const debit = makeTransaction({ userId: 1, accountId: 1, amount: -1000, transactionType: TransactionTypeEnum.DEBIT });
    const credit = makeTransaction({ userId: 1, accountId: 2, amount: 1000, transactionType: TransactionTypeEnum.CREDIT });
    transactionRepository.candidates = [credit];

    await service.detectForTransaction(debit);

    assert.equal(transferLinkRepository.links.length, 0);
  });

  test('always_transfer rule links at rule_based confidence even outside normal FX tolerance', async () => {
    const { transactionRepository, transferLinkRepository, ruleRepository, service } = setup(1600);
    ruleRepository.rules.push({
      id: 1,
      userId: 1,
      accountAId: 1,
      accountBId: 2,
      decision: 'always_transfer',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
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
      amount: 149000, // implied rate 1490, ~6.9% off 1600 — outside normal 3% but inside the 8% rule-trusted tolerance
      transactionType: TransactionTypeEnum.CREDIT,
    });
    transactionRepository.candidates = [credit];

    await service.detectForTransaction(debit);

    assert.equal(transferLinkRepository.links.length, 1);
    assert.equal(transferLinkRepository.links[0].confidence, 'rule_based');
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

  test('excludes an unmatched self_transfer leg alone, even with no counterpart ever ingested', async () => {
    const { transactionRepository, transferLinkRepository, service } = setup();
    const debit = makeTransaction({
      userId: 1,
      accountId: 1,
      category: CategoryEnum.SELF_TRANSFER,
      transactionType: TransactionTypeEnum.DEBIT,
    });
    transactionRepository.candidates = [];

    await service.detectForTransaction(debit);

    assert.equal(transferLinkRepository.links.length, 1);
    assert.equal(transferLinkRepository.links[0].linkType, 'internal_transfer');
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
