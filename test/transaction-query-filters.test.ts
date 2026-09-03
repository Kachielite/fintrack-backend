import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TransactionQuerySchema } from '../src/modules/transaction/transaction.dto';

describe('TransactionQuerySchema multi-value filters (fintrack-backend#138)', () => {
  test('a single value still works as a 1-element array', () => {
    const result = TransactionQuerySchema.parse({ category: 'groceries', currency: 'NGN', bank_id: '1', account_id: '2' });

    assert.deepEqual(result.category, ['groceries']);
    assert.deepEqual(result.currency, ['NGN']);
    assert.deepEqual(result.bank_id, [1]);
    assert.deepEqual(result.account_id, [2]);
  });

  test('a comma-separated list parses into multiple values, matching the frontend filter UI\'s multi-select', () => {
    const result = TransactionQuerySchema.parse({
      category: 'groceries,transport',
      currency: 'NGN,USD',
      bank_id: '1,2,3',
      account_id: '4,5',
    });

    assert.deepEqual(result.category, ['groceries', 'transport']);
    assert.deepEqual(result.currency, ['NGN', 'USD']);
    assert.deepEqual(result.bank_id, [1, 2, 3]);
    assert.deepEqual(result.account_id, [4, 5]);
  });

  test('surrounding whitespace around commas is trimmed', () => {
    const result = TransactionQuerySchema.parse({ category: ' groceries , transport ', bank_id: ' 1 , 2 ' });

    assert.deepEqual(result.category, ['groceries', 'transport']);
    assert.deepEqual(result.bank_id, [1, 2]);
  });

  test('non-numeric entries in a number list are dropped rather than failing the whole request', () => {
    const result = TransactionQuerySchema.parse({ bank_id: '1,notanumber,3' });

    assert.deepEqual(result.bank_id, [1, 3]);
  });

  test('omitting a filter leaves it undefined - no filtering applied', () => {
    const result = TransactionQuerySchema.parse({});

    assert.equal(result.category, undefined);
    assert.equal(result.currency, undefined);
    assert.equal(result.bank_id, undefined);
    assert.equal(result.account_id, undefined);
  });
});
