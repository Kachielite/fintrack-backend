import 'reflect-metadata';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import AdminService from '../src/modules/admin/admin.service';
import { IAdminRepository, IAiUsageRepository } from '../src/modules/admin/admin.repository';

// Only what getAiUsage actually calls is implemented for real - anything
// else throws, so an unexpected dependency surfaces immediately as a test
// failure.
class FakeAdminRepository implements Partial<IAdminRepository> {
  byOperation: Record<string, unknown>[] = [];
  trend: Record<string, unknown>[] = [];
  costTrend: Record<string, unknown>[] = [];

  async getAiUsageByPeriod() {
    return { byOperation: this.byOperation, trend: this.trend, costTrend: this.costTrend };
  }

  async getTransactionStats() {
    return {
      totalCount: 0,
      count30d: 100,
      handledByRegex: 0,
      handledByAi: 0,
      failedIngestion30d: 0,
      unverifiedCount: 0,
    };
  }
}

function makeService(repo: FakeAdminRepository) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new AdminService(repo as any, {} as IAiUsageRepository, {} as any);
}

describe('getAiUsage per-model cost aggregation (fintrack-backend#141)', () => {
  test('a single operation split across two models is priced per-model, then summed into one entry', async () => {
    const repo = new FakeAdminRepository();
    // Same operation, same token counts, but one row ran on gpt-4o and the
    // other on gpt-4o-mini - the old flat-rate calculation would have priced
    // both identically.
    repo.byOperation = [
      {
        operation: 'extract_transaction',
        model_used: 'gpt-4o',
        call_count: 1,
        prompt_tokens: 1000,
        completion_tokens: 500,
        total_tokens: 1500,
      },
      {
        operation: 'extract_transaction',
        model_used: 'gpt-4o-mini',
        call_count: 1,
        prompt_tokens: 1000,
        completion_tokens: 500,
        total_tokens: 1500,
      },
    ];

    const service = makeService(repo);
    const result = await service.getAiUsage({});

    assert.equal(result.by_operation.length, 1, 'both model rows collapse into one operation entry');
    const entry = result.by_operation[0];
    assert.equal(entry.operation, 'extract_transaction');
    assert.equal(entry.call_count, 2);
    assert.equal(entry.total_tokens, 3000);

    // gpt-4o: (1000/1000)*0.0025 + (500/1000)*0.010 = 0.0025 + 0.005 = 0.0075
    // gpt-4o-mini: (1000/1000)*0.00015 + (500/1000)*0.0006 = 0.00015 + 0.0003 = 0.00045
    const expectedCost = 0.0075 + 0.00045;
    assert.ok(
      Math.abs(entry.estimated_cost_usd - expectedCost) < 1e-9,
      `expected ~${expectedCost}, got ${entry.estimated_cost_usd}`,
    );
  });

  test('totals.estimated_cost_usd reflects per-model pricing, not a flat rate on the aggregate', async () => {
    const repo = new FakeAdminRepository();
    repo.byOperation = [
      {
        operation: 'infer_category',
        model_used: 'gpt-4o-mini',
        call_count: 10,
        prompt_tokens: 10_000,
        completion_tokens: 5_000,
        total_tokens: 15_000,
      },
    ];

    const service = makeService(repo);
    const result = await service.getAiUsage({});

    // If this were still priced at the flat gpt-4o rate, cost would be
    // (10000/1000)*0.0025 + (5000/1000)*0.010 = 0.075. At the correct
    // gpt-4o-mini rate it should be about 1/17th of that.
    const flatGpt4oCost = 0.075;
    assert.ok(
      result.totals.estimated_cost_usd < flatGpt4oCost / 10,
      `expected far below the flat gpt-4o cost of ${flatGpt4oCost}, got ${result.totals.estimated_cost_usd}`,
    );
  });

  test('an empty period returns zeroed totals without throwing', async () => {
    const repo = new FakeAdminRepository();
    const service = makeService(repo);

    const result = await service.getAiUsage({});

    assert.equal(result.by_operation.length, 0);
    assert.equal(result.totals.estimated_cost_usd, 0);
    assert.equal(result.totals.call_count, 0);
  });
});
