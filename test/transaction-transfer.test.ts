import 'reflect-metadata';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import TransactionService from '../src/modules/transaction/transaction.service';
import { ITransactionRepository } from '../src/modules/transaction/transaction.repository';
import { ITransaction } from '../src/modules/transaction/transaction.interface';
import { TransactionTypeEnum, TransactionStatusEnum, CategoryEnum } from '../src/modules/transaction/transaction.enum';
import { ITransferLinkRepository } from '../src/modules/account/transfer-link.repository';
import { ITransferLink } from '../src/modules/account/transfer-link.interface';

let nextTxnId = 1;

function makeTransaction(overrides: Partial<ITransaction> & { userId: number }): ITransaction {
  return {
    id: nextTxnId++,
    emailConnectionId: null,
    bankId: 1,
    accountId: 1,
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
  implements Pick<ITransactionRepository, 'findById' | 'markExcludedFromTotals' | 'markIncludedInTotals'>
{
  transactions: ITransaction[] = [];

  async findById(id: number, userId: number): Promise<ITransaction | null> {
    return this.transactions.find((t) => t.id === id && t.userId === userId) ?? null;
  }

  async markExcludedFromTotals(ids: number[]): Promise<void> {
    for (const t of this.transactions) if (ids.includes(t.id)) t.excludeFromTotals = true;
  }

  async markIncludedInTotals(ids: number[]): Promise<void> {
    for (const t of this.transactions) if (ids.includes(t.id)) t.excludeFromTotals = false;
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

function setup() {
  const transactionRepository = new FakeTransactionRepository();
  const transferLinkRepository = new FakeTransferLinkRepository();
  const service = new TransactionService(
    transactionRepository as unknown as ITransactionRepository,
    {} as any,
    {} as any,
    transferLinkRepository,
    {} as any,
    {} as any,
    {} as any,
  );
  return { transactionRepository, transferLinkRepository, service };
}

describe('TransactionService.markTransfer', () => {
  test('pairs two opposite-sign transactions, links them, and excludes both', async () => {
    const { transactionRepository, transferLinkRepository, service } = setup();
    const debit = makeTransaction({ userId: 1, transactionType: TransactionTypeEnum.DEBIT, currency: 'NGN' });
    const credit = makeTransaction({ userId: 1, transactionType: TransactionTypeEnum.CREDIT, currency: 'NGN' });
    transactionRepository.transactions.push(debit, credit);

    const result = await service.markTransfer(1, debit.id, credit.id);

    assert.equal(result.excludeFromTotals, true);
    assert.equal(credit.excludeFromTotals, true);
    assert.equal(transferLinkRepository.links.length, 1);
    assert.deepEqual(transferLinkRepository.links[0], {
      id: 1,
      userId: 1,
      fromTransactionId: debit.id,
      toTransactionId: credit.id,
      linkType: 'internal_transfer',
      confidence: 'user_created',
      createdAt: transferLinkRepository.links[0].createdAt,
    });
  });

  test('uses currency_conversion as the link type for a cross-currency manual pair', async () => {
    const { transactionRepository, transferLinkRepository, service } = setup();
    const debit = makeTransaction({ userId: 1, transactionType: TransactionTypeEnum.DEBIT, currency: 'USD' });
    const credit = makeTransaction({ userId: 1, transactionType: TransactionTypeEnum.CREDIT, currency: 'NGN' });
    transactionRepository.transactions.push(debit, credit);

    await service.markTransfer(1, debit.id, credit.id);

    assert.equal(transferLinkRepository.links[0].linkType, 'currency_conversion');
  });

  test('excludes a transaction alone when no linked_transaction_id is given', async () => {
    const { transactionRepository, transferLinkRepository, service } = setup();
    const debit = makeTransaction({ userId: 1, transactionType: TransactionTypeEnum.DEBIT });
    transactionRepository.transactions.push(debit);

    const result = await service.markTransfer(1, debit.id);

    assert.equal(result.excludeFromTotals, true);
    assert.deepEqual(transferLinkRepository.links[0].fromTransactionId, debit.id);
    assert.equal(transferLinkRepository.links[0].toTransactionId, null);
  });

  test('rejects pairing two transactions of the same direction', async () => {
    const { transactionRepository, service } = setup();
    const a = makeTransaction({ userId: 1, transactionType: TransactionTypeEnum.DEBIT });
    const b = makeTransaction({ userId: 1, transactionType: TransactionTypeEnum.DEBIT });
    transactionRepository.transactions.push(a, b);

    await assert.rejects(() => service.markTransfer(1, a.id, b.id));
  });

  test('rejects linking a transaction to itself', async () => {
    const { transactionRepository, service } = setup();
    const a = makeTransaction({ userId: 1 });
    transactionRepository.transactions.push(a);

    await assert.rejects(() => service.markTransfer(1, a.id, a.id));
  });

  test('rejects a nonexistent or foreign linked transaction', async () => {
    const { transactionRepository, service } = setup();
    const a = makeTransaction({ userId: 1 });
    transactionRepository.transactions.push(a);

    await assert.rejects(() => service.markTransfer(1, a.id, 9999));
  });

  test('rejects marking a nonexistent or foreign transaction', async () => {
    const { service } = setup();
    await assert.rejects(() => service.markTransfer(1, 9999));
  });

  test('replaces an existing pairing rather than layering a second link on top', async () => {
    const { transactionRepository, transferLinkRepository, service } = setup();
    const debit = makeTransaction({ userId: 1, transactionType: TransactionTypeEnum.DEBIT });
    const oldCredit = makeTransaction({ userId: 1, transactionType: TransactionTypeEnum.CREDIT });
    const newCredit = makeTransaction({ userId: 1, transactionType: TransactionTypeEnum.CREDIT });
    transactionRepository.transactions.push(debit, oldCredit, newCredit);

    await service.markTransfer(1, debit.id, oldCredit.id);
    await service.markTransfer(1, debit.id, newCredit.id);

    assert.equal(transferLinkRepository.links.length, 1);
    assert.equal(transferLinkRepository.links[0].toTransactionId, newCredit.id);
    assert.equal(oldCredit.excludeFromTotals, false);
    assert.equal(newCredit.excludeFromTotals, true);
  });
});

describe('TransactionService.unmarkTransfer', () => {
  test('removes the link and re-includes both legs in totals', async () => {
    const { transactionRepository, transferLinkRepository, service } = setup();
    const debit = makeTransaction({ userId: 1, transactionType: TransactionTypeEnum.DEBIT });
    const credit = makeTransaction({ userId: 1, transactionType: TransactionTypeEnum.CREDIT });
    transactionRepository.transactions.push(debit, credit);
    await service.markTransfer(1, debit.id, credit.id);

    const result = await service.unmarkTransfer(1, debit.id);

    assert.equal(result.excludeFromTotals, false);
    assert.equal(credit.excludeFromTotals, false);
    assert.equal(transferLinkRepository.links.length, 0);
  });

  test('is a no-op on a transaction that was never marked', async () => {
    const { transactionRepository, service } = setup();
    const a = makeTransaction({ userId: 1 });
    transactionRepository.transactions.push(a);

    const result = await service.unmarkTransfer(1, a.id);
    assert.equal(result.excludeFromTotals, false);
  });

  test('rejects a nonexistent or foreign transaction', async () => {
    const { service } = setup();
    await assert.rejects(() => service.unmarkTransfer(1, 9999));
  });
});

describe('TransactionService.getLinkedTransaction', () => {
  test('returns the paired leg', async () => {
    const { transactionRepository, service } = setup();
    const debit = makeTransaction({ userId: 1, transactionType: TransactionTypeEnum.DEBIT });
    const credit = makeTransaction({ userId: 1, transactionType: TransactionTypeEnum.CREDIT });
    transactionRepository.transactions.push(debit, credit);
    await service.markTransfer(1, debit.id, credit.id);

    const linked = await service.getLinkedTransaction(1, debit.id);
    assert.equal(linked?.id, credit.id);

    const linkedFromOtherSide = await service.getLinkedTransaction(1, credit.id);
    assert.equal(linkedFromOtherSide?.id, debit.id);
  });

  test('returns null when there is no link', async () => {
    const { transactionRepository, service } = setup();
    const a = makeTransaction({ userId: 1 });
    transactionRepository.transactions.push(a);

    assert.equal(await service.getLinkedTransaction(1, a.id), null);
  });

  test('returns null for a single-leg (unpaired) exclusion', async () => {
    const { transactionRepository, service } = setup();
    const a = makeTransaction({ userId: 1 });
    transactionRepository.transactions.push(a);
    await service.markTransfer(1, a.id);

    assert.equal(await service.getLinkedTransaction(1, a.id), null);
  });

  test('rejects a nonexistent or foreign transaction', async () => {
    const { service } = setup();
    await assert.rejects(() => service.getLinkedTransaction(1, 9999));
  });
});
