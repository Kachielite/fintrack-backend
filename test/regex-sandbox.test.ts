import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execRuleBatchWithTimeout } from '../src/modules/parser-rule/regex-sandbox';

describe('execRuleBatchWithTimeout', () => {
  test('returns matched groups for a normal, fast pattern', async () => {
    const result = await execRuleBatchWithTimeout(
      [{ pattern: 'Amount:\\s*([\\d,]+\\.\\d{2})', flags: 'i', extractGroup: 1 }],
      'Amount: 5,000.00\nDate: today',
      500,
    );

    assert.equal(result.timedOut, false);
    if (result.timedOut) return;
    assert.deepEqual(result.results, ['5,000.00']);
  });

  test('returns null for rules that do not match, alongside ones that do', async () => {
    const result = await execRuleBatchWithTimeout(
      [
        { pattern: 'Amount:\\s*([\\d,]+\\.\\d{2})', flags: 'i', extractGroup: 1 },
        { pattern: 'Merchant:\\s*(\\w+)', flags: 'i', extractGroup: 1 },
      ],
      'Amount: 5,000.00\nDate: today',
      500,
    );

    assert.equal(result.timedOut, false);
    if (result.timedOut) return;
    assert.deepEqual(result.results, ['5,000.00', null]);
  });

  test('times out and terminates on a catastrophic-backtracking pattern', async () => {
    // Classic ReDoS shape: (a+)+ against a long run of a's with no match at
    // the end forces exponential backtracking.
    const evilInput = 'a'.repeat(35) + '!';
    const result = await execRuleBatchWithTimeout(
      [{ pattern: '(a+)+$', flags: '', extractGroup: 1 }],
      evilInput,
      150,
    );

    assert.equal(result.timedOut, true);
    assert.equal(result.results, null);
  });

  test('an invalid regex pattern in the batch resolves to null instead of crashing the batch', async () => {
    const result = await execRuleBatchWithTimeout(
      [{ pattern: '[invalid(', flags: 'i', extractGroup: 1 }],
      'some text',
      500,
    );

    assert.equal(result.timedOut, false);
    if (result.timedOut) return;
    assert.deepEqual(result.results, [null]);
  });

  test('an empty rule batch resolves immediately without spawning a worker', async () => {
    const result = await execRuleBatchWithTimeout([], 'some text', 500);

    assert.equal(result.timedOut, false);
    if (result.timedOut) return;
    assert.deepEqual(result.results, []);
  });

  // fintrack-backend#185: the timeout used to start counting at `new Worker()`,
  // so OS thread-spawn/eval-compile time (which spikes under concurrent load,
  // since many batches spawn workers at once and contend for creation) ate
  // into the budget meant for regex execution. Firing many batches at once
  // with a trivially-fast, safe pattern and a modest (not razor-thin) timeout
  // reproduces that contention; none of them should time out now that the
  // timer only starts after the worker signals it's alive.
  test('a burst of concurrent batches with a trivial pattern does not false-positive under spawn contention', async () => {
    const concurrency = 25;
    const results = await Promise.all(
      Array.from({ length: concurrency }, () =>
        execRuleBatchWithTimeout(
          [{ pattern: 'Amount:\\s*([\\d,]+\\.\\d{2})', flags: 'i', extractGroup: 1 }],
          'Amount: 5,000.00\nDate: today',
          100,
        ),
      ),
    );

    for (const result of results) {
      assert.equal(result.timedOut, false);
      if (result.timedOut) continue;
      assert.deepEqual(result.results, ['5,000.00']);
    }
  });
});
