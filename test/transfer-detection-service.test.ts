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

class FakeTransactionRepository implements Pick<ITransactionRepository, 'findTransferCandidates' | 'markExcludedFromTotals'> {
  candidates: ITransaction[] = [];
  excludedIds: number[] = [];

  async findTransferCandidates(): Promise<ITransaction[]> {
    return this.candidates;
  }

  async markExcludedFromTotals(ids: number[]): Promise<void> {
    this.excludedIds.push(...ids);
  }
}

class FakeTransferLinkRepository implements ITransferLinkRepository {
  links: Array<{
    userId: number;
    fromTransactionId: number | null;
    toTransactionId: number | null;
    linkType: string;
    confidence: string;
  }> = [];

  async create(data: {
    userId: number;
    fromTransactionId: number | null;
    toTransactionId: number | null;
    linkType: string;
    confidence: string;
  }): Promise<ITransferLink> {
    this.links.push(data);
    return { id: this.links.length, createdAt: new Date(), ...data };
  }

  async findByTransactionId(): Promise<ITransferLink | null> {
    throw new Error('not used by TransferDetectionService');
  }

  async delete(): Promise<void> {
    throw new Error('not used by TransferDetectionService');
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
    assert.deepEqual(transferLinkRepository.links[0], {
      userId: 1,
      fromTransactionId: debit.id,
      toTransactionId: credit.id,
      linkType: 'internal_transfer',
      confidence: 'auto_high',
    });
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
    assert.deepEqual(transferLinkRepository.links[0], {
      userId: 1,
      fromTransactionId: debit.id,
      toTransactionId: null,
      linkType: 'currency_conversion',
      confidence: 'auto_low',
    });
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
