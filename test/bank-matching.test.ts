import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { matchBank, extractDomain, normalizeEmail } from '../src/modules/bank/bank-matching';
import { IBank } from '../src/modules/bank/bank.interface';
import { BankMatch } from '../src/modules/bank/bank-matching';

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

function assertMatch(result: BankMatch | null): asserts result is BankMatch {
  assert.ok(result !== null, 'Expected a BankMatch but got null');
}

const ZENITH = makeBank({
  id: 1,
  name: 'Zenith Bank',
  shortCode: 'zenith',
  knownSenderEmails: ['alerts@zenithbank.com', 'ebusinessgroup@zenithbank.com'],
  knownSenderDomains: ['zenithbank.com'],
});

const GTB = makeBank({
  id: 2,
  name: 'GTBank',
  shortCode: 'gtbank',
  knownSenderEmails: ['gens@gtbank.com', 'noreply@gtbank.com'],
  knownSenderDomains: ['gtbank.com'],
});

// A legacy bank: no explicit knownSenderDomains, only derived-domain matching.
const LEGACY = makeBank({
  id: 3,
  name: 'LegacyBank',
  shortCode: 'legacy',
  knownSenderEmails: ['alerts@legacybank.ng'],
  knownSenderDomains: [],
});

const ALL_BANKS = [ZENITH, GTB, LEGACY];

describe('normalizeEmail', () => {
  test('lowercases and trims whitespace', () => {
    assert.equal(normalizeEmail('  Alerts@ZenithBank.COM  '), 'alerts@zenithbank.com');
  });
});

describe('extractDomain', () => {
  test('extracts domain from well-formed email', () => {
    assert.equal(extractDomain('alerts@zenithbank.com'), 'zenithbank.com');
  });
  test('returns null for a string with no @', () => {
    assert.equal(extractDomain('notanemail'), null);
  });
  test('returns null when @ is the last character', () => {
    assert.equal(extractDomain('user@'), null);
  });
});

describe('matchBank', () => {
  test('exact sender email match -> exact_sender_email', () => {
    const result = matchBank(ALL_BANKS, 'alerts@zenithbank.com');
    assertMatch(result);
    assert.equal(result.bank.shortCode, 'zenith');
    assert.equal(result.source, 'exact_sender_email');
  });

  test('exact match is case-insensitive', () => {
    const result = matchBank(ALL_BANKS, 'ALERTS@ZENITHBANK.COM');
    assertMatch(result);
    assert.equal(result.source, 'exact_sender_email');
  });

  test('new address on explicit trusted domain -> trusted_sender_domain', () => {
    const result = matchBank(ALL_BANKS, 'newaddress@zenithbank.com');
    assertMatch(result);
    assert.equal(result.bank.shortCode, 'zenith');
    assert.equal(result.source, 'trusted_sender_domain');
  });

  test('legacy bank matched via derived domain -> legacy_domain_fallback', () => {
    const result = matchBank(ALL_BANKS, 'unknown@legacybank.ng');
    assertMatch(result);
    assert.equal(result.bank.shortCode, 'legacy');
    assert.equal(result.source, 'legacy_domain_fallback');
  });

  test('ambiguous trusted domain (two banks share domain) -> null', () => {
    const bankA = makeBank({ id: 10, name: 'BankA', shortCode: 'banka', knownSenderDomains: ['shared.com'] });
    const bankB = makeBank({ id: 11, name: 'BankB', shortCode: 'bankb', knownSenderDomains: ['shared.com'] });
    assert.equal(matchBank([bankA, bankB], 'alerts@shared.com'), null);
  });

  test('ambiguous legacy domain (two banks, same derived domain) -> null', () => {
    const bankA = makeBank({ id: 12, name: 'BankA', shortCode: 'banka2', knownSenderEmails: ['a@shared2.com'] });
    const bankB = makeBank({ id: 13, name: 'BankB', shortCode: 'bankb2', knownSenderEmails: ['b@shared2.com'] });
    assert.equal(matchBank([bankA, bankB], 'c@shared2.com'), null);
  });

  test('completely unknown domain -> null', () => {
    assert.equal(matchBank(ALL_BANKS, 'alerts@unknownbank.io'), null);
  });

  test('exact match wins over a domain conflict with another bank', () => {
    // GTB hypothetically also has zenithbank.com in trusted domains.
    // Tier-1 exact match on ZENITH should win before tier-2 domain check.
    const gtbWithZenithDomain = makeBank({
      ...GTB,
      id: 99,
      knownSenderDomains: ['gtbank.com', 'zenithbank.com'],
    });
    const result = matchBank([ZENITH, gtbWithZenithDomain], 'alerts@zenithbank.com');
    assertMatch(result);
    assert.equal(result.bank.shortCode, 'zenith');
    assert.equal(result.source, 'exact_sender_email');
  });

  test('malformed email with no @ -> null', () => {
    assert.equal(matchBank(ALL_BANKS, 'notanemail'), null);
  });
});
