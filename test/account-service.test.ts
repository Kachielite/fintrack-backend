import 'reflect-metadata';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import AccountService from '../src/modules/account/account.service';
import { IAccountRepository } from '../src/modules/account/account.repository';
import { IAccount } from '../src/modules/account/account.interface';
import { IBankRepository } from '../src/modules/bank/bank.repository';
import { IBank } from '../src/modules/bank/bank.interface';

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
}

class FakeBankRepository implements Pick<IBankRepository, 'findById'> {
  constructor(private banks: IBank[]) {}
  async findById(id: number): Promise<IBank | null> {
    return this.banks.find((b) => b.id === id) ?? null;
  }
}

const ZENITH = makeBank({ id: 1, name: 'Zenith Bank', shortCode: 'zenith' });

function setup() {
  const accountRepository = new FakeAccountRepository();
  const bankRepository = new FakeBankRepository([ZENITH]) as unknown as IBankRepository;
  const service = new AccountService(accountRepository, bankRepository);
  return { accountRepository, service };
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
