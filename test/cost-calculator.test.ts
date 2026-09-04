import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { calculateCostUsd } from '../src/common/utils/cost-calculator';
import logger from '../src/common/lib/logger';

describe('calculateCostUsd (fintrack-backend#141)', () => {
  test('with no model given, uses gpt-4o pricing (backward compatible)', () => {
    const noModel = calculateCostUsd(1000, 1000);
    const explicitGpt4o = calculateCostUsd(1000, 1000, 'gpt-4o');
    assert.equal(noModel, explicitGpt4o);
  });

  test('gpt-4o-mini is priced far cheaper than gpt-4o for the same token count', () => {
    const gpt4oCost = calculateCostUsd(10_000, 5_000, 'gpt-4o');
    const miniCost = calculateCostUsd(10_000, 5_000, 'gpt-4o-mini');

    assert.ok(miniCost < gpt4oCost, 'mini should be cheaper');
    // Real gpt-4o-mini pricing is roughly 1/17th of gpt-4o's - the exact bug
    // this ticket fixes was applying gpt-4o's rate to gpt-4o-mini calls.
    const ratio = gpt4oCost / miniCost;
    assert.ok(ratio > 15 && ratio < 18, `expected ~16-17x cheaper, got ${ratio}x`);
  });

  test('an unrecognized model name falls back to gpt-4o pricing and logs a warning', () => {
    const warnCalls: string[] = [];
    const originalWarn = logger.warn;
    logger.warn = ((msg: string) => {
      warnCalls.push(msg);
    }) as typeof logger.warn;

    try {
      const unknown = calculateCostUsd(1000, 1000, 'some-future-model');
      const gpt4o = calculateCostUsd(1000, 1000, 'gpt-4o');
      assert.equal(unknown, gpt4o);
      assert.equal(warnCalls.length, 1);
      assert.match(warnCalls[0], /some-future-model/);
    } finally {
      logger.warn = originalWarn;
    }
  });

  test('zero tokens costs zero regardless of model', () => {
    assert.equal(calculateCostUsd(0, 0, 'gpt-4o-mini'), 0);
    assert.equal(calculateCostUsd(0, 0), 0);
  });
});
