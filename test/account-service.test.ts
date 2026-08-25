import 'reflect-metadata';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import AccountService from '../src/modules/account/account.service';
import { IAccountRepository } from '../src/modules/account/account.repository';
import { IAccount } from '../src/modules/account/account.interface';
import { IBankRepository } from '../src/modules/bank/bank.repository';
import { IBank } from '../src/modules/bank/bank.interface';
import { ITransactionRepository } from '../src/modules/transaction/transaction.repository';

function makeAccount(overrides: Partial<IAccount> & { id: number; userId: number; currency: string }): IAccount {
  return {
    bankId: null,
    label: 'Account',
    accountNumberMask: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeBank(overrides: Partial<IBank> & { id: number; name: string; shortCode: string }): IBank {
  return {
    country: null,
    knownSenderEmails: [],
    knownSenderDomains: [],
    logoUrl: null,
    isActive: true,
    createdAt: new Date(),
    ...overrides,
  };
}

class FakeAccountRepository implements IAccountRepository {
  accounts: IAccount[] = [];
  private nextId = 1;

  async findMatch(userId: number, bankId: number | null, currency: string): Promise<IAccount | null> {
    return (
      this.accounts.find((a) => a.userId === userId && a.bankId === bankId && a.currency === currency) ?? null
    );
  }

  async create(data: {
    userId: number;
    bankId: number | null;
    currency: string;
    label: string;
    accountNumberMask?: string | null;
  }): Promise<IAccount> {
    const account = makeAccount({
      id: this.nextId++,
      userId: data.userId,
      bankId: data.bankId,
      currency: data.currency,
      label: data.label,
      accountNumberMask: data.accountNumberMask ?? null,
    });
    this.accounts.push(account);
    return account;
  }

  async setMask(id: number, mask: string): Promise<IAccount> {
    const account = this.accounts.find((a) => a.id === id);
    if (!account) throw new Error('Account not found');
    account.accountNumberMask = mask;
    return account;
  }

  async findAllByUser(userId: number): Promise<IAccount[]> {
    return this.accounts.filter((a) => a.userId === userId && a.isActive);
  }

  async findById(id: number, userId: number): Promise<IAccount | null> {
    return this.accounts.find((a) => a.id === id && a.userId === userId) ?? null;
  }

  async update(id: number, userId: number, data: { label?: string; isActive?: boolean }): Promise<IAccount> {
    const account = this.accounts.find((a) => a.id === id && a.userId === userId);
    if (!account) throw new Error('Account not found');
    if (data.label !== undefined) account.label = data.label;
    if (data.isActive !== undefined) account.isActive = data.isActive;
    return account;
  }
}

class FakeBankRepository implements Pick<IBankRepository, 'findById'> {
  constructor(private banks: IBank[]) {}
  async findById(id: number): Promise<IBank | null> {
    return this.banks.find((b) => b.id === id) ?? null;
  }
}

class FakeTransactionRepository
  implements Pick<ITransactionRepository, 'findLatestBalance' | 'reassignAccount' | 'countByAccount'>
{
  balances = new Map<number, { balance: number; transactionDate: Date }>();
  reassignments: Array<{ userId: number; from: number; to: number }> = [];
  accountCounts = new Map<number, number>();

  async findLatestBalance(accountId: number): Promise<{ balance: number; transactionDate: Date } | null> {
    return this.balances.get(accountId) ?? null;
  }

  async reassignAccount(userId: number, fromAccountId: number, toAccountId: number): Promise<number> {
    this.reassignments.push({ userId, from: fromAccountId, to: toAccountId });
    return 3;
  }

  async countByAccount(userId: number, accountId: number): Promise<number> {
    return this.accountCounts.get(accountId) ?? 0;
  }
}

const ZENITH = makeBank({ id: 1, name: 'Zenith Bank', shortCode: 'zenith' });

function setup() {
  const accountRepository = new FakeAccountRepository();
  const bankRepository = new FakeBankRepository([ZENITH]) as unknown as IBankRepository;
  const transactionRepository = new FakeTransactionRepository() as unknown as ITransactionRepository;
  const service = new AccountService(accountRepository, bankRepository, transactionRepository);
  return { accountRepository, bankRepository, transactionRepository, service };
}

describe('AccountService.resolveOrCreate', () => {
  test('creates a new account with a bank/currency-derived label when nothing matches', async () => {
    const { service } = setup();
    const account = await service.resolveOrCreate(1, ZENITH.id, 'NGN');
    assert.equal(account.userId, 1);
    assert.equal(account.bankId, ZENITH.id);
    assert.equal(account.currency, 'NGN');
    assert.equal(account.label, 'Zenith Bank (NGN)');
    assert.equal(account.accountNumberMask, null);
  });

  test('falls back to a generic label when bankId is null', async () => {
    const { service } = setup();
    const account = await service.resolveOrCreate(1, null, 'USD');
    assert.equal(account.label, 'Account (USD)');
  });

  test('returns the existing account instead of creating a duplicate', async () => {
    const { service, accountRepository } = setup();
    const first = await service.resolveOrCreate(1, ZENITH.id, 'NGN');
    const second = await service.resolveOrCreate(1, ZENITH.id, 'NGN');
    assert.equal(second.id, first.id);
    assert.equal(accountRepository.accounts.length, 1);
  });

  test('keeps accounts separate per user, bank, and currency', async () => {
    const { service, accountRepository } = setup();
    await service.resolveOrCreate(1, ZENITH.id, 'NGN');
    await service.resolveOrCreate(2, ZENITH.id, 'NGN');
    await service.resolveOrCreate(1, ZENITH.id, 'USD');
    assert.equal(accountRepository.accounts.length, 3);
  });

  test('backfills a mask onto an existing account that has none', async () => {
    const { service } = setup();
    await service.resolveOrCreate(1, ZENITH.id, 'NGN');
    const updated = await service.resolveOrCreate(1, ZENITH.id, 'NGN', '1234');
    assert.equal(updated.accountNumberMask, '1234');
  });

  test('does not overwrite an existing mask with a different one', async () => {
    const { service } = setup();
    await service.resolveOrCreate(1, ZENITH.id, 'NGN', '1234');
    const updated = await service.resolveOrCreate(1, ZENITH.id, 'NGN', '9999');
    assert.equal(updated.accountNumberMask, '1234');
  });
});

describe('AccountService.listAccounts', () => {
  test('includes a computed balance sourced from the latest transaction', async () => {
    const { service, transactionRepository } = setup();
    const account = await service.resolveOrCreate(1, ZENITH.id, 'NGN');
    (transactionRepository as any).balances.set(account.id, {
      balance: 42000,
      transactionDate: new Date('2026-01-05'),
    });

    const [dto] = await service.listAccounts(1);
    assert.equal(dto.id, account.id);
    assert.equal(dto.bank_name, 'Zenith Bank');
    assert.equal(dto.balance, 42000);
    assert.equal(dto.last_synced_at, new Date('2026-01-05').toISOString());
  });

  test('returns null balance when no transaction has captured one yet', async () => {
    const { service } = setup();
    await service.resolveOrCreate(1, ZENITH.id, 'NGN');
    const [dto] = await service.listAccounts(1);
    assert.equal(dto.balance, null);
    assert.equal(dto.last_synced_at, null);
  });

  test('excludes deactivated accounts', async () => {
    const { service } = setup();
    const account = await service.resolveOrCreate(1, ZENITH.id, 'NGN');
    await service.updateAccount(1, account.id, { is_active: false });
    const accounts = await service.listAccounts(1);
    assert.equal(accounts.length, 0);
  });
});

describe('AccountService.updateAccount', () => {
  test('renames an account', async () => {
    const { service } = setup();
    const account = await service.resolveOrCreate(1, ZENITH.id, 'NGN');
    const updated = await service.updateAccount(1, account.id, { label: 'My Dollar Account' });
    assert.equal(updated.label, 'My Dollar Account');
  });

  test('deactivates an account', async () => {
    const { service } = setup();
    const account = await service.resolveOrCreate(1, ZENITH.id, 'NGN');
    const updated = await service.updateAccount(1, account.id, { is_active: false });
    assert.equal(updated.is_active, false);
  });

  test('merges one account into another: reassigns transactions and deactivates the source', async () => {
    const { service, transactionRepository } = setup();
    const source = await service.resolveOrCreate(1, ZENITH.id, 'NGN');
    const target = await service.resolveOrCreate(1, ZENITH.id, 'USD');

    const updated = await service.updateAccount(1, source.id, { merge_into_account_id: target.id });

    assert.equal(updated.is_active, false);
    assert.deepEqual((transactionRepository as any).reassignments, [{ userId: 1, from: source.id, to: target.id }]);
  });

  test('rejects merging an account into itself', async () => {
    const { service } = setup();
    const account = await service.resolveOrCreate(1, ZENITH.id, 'NGN');
    await assert.rejects(() => service.updateAccount(1, account.id, { merge_into_account_id: account.id }));
  });

  test('rejects merging into a nonexistent or foreign account', async () => {
    const { service } = setup();
    const account = await service.resolveOrCreate(1, ZENITH.id, 'NGN');
    await assert.rejects(() => service.updateAccount(1, account.id, { merge_into_account_id: 9999 }));
  });

  test('rejects updating a nonexistent or foreign account', async () => {
    const { service } = setup();
    await assert.rejects(() => service.updateAccount(1, 9999, { label: 'Nope' }));
  });
});

describe('AccountService.deactivateOrphaned', () => {
  test('deactivates a candidate account left with zero transactions', async () => {
    const { service, transactionRepository } = setup();
    const account = await service.resolveOrCreate(1, ZENITH.id, 'NGN');
    (transactionRepository as any).accountCounts.set(account.id, 0);

    const deactivated = await service.deactivateOrphaned(1, [account.id]);

    assert.equal(deactivated, 1);
    const found = await service.findOwnedAccount(1, account.id);
    assert.equal(found?.isActive, false);
  });

  test('leaves an account alone if it still has transactions from another source', async () => {
    const { service, transactionRepository } = setup();
    const account = await service.resolveOrCreate(1, ZENITH.id, 'NGN');
    (transactionRepository as any).accountCounts.set(account.id, 2);

    const deactivated = await service.deactivateOrphaned(1, [account.id]);

    assert.equal(deactivated, 0);
    const found = await service.findOwnedAccount(1, account.id);
    assert.equal(found?.isActive, true);
  });

  test('is a no-op for an empty candidate list', async () => {
    const { service } = setup();
    const deactivated = await service.deactivateOrphaned(1, []);
    assert.equal(deactivated, 0);
  });
});
