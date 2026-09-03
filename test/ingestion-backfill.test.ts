import 'reflect-metadata';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import IngestionService, {
  formatGmailAfterDate,
  resolveBackfillWindowDays,
} from '../src/modules/ingestion/ingestion.service';

// resolveTransactionDate (and the sibling helpers it calls) never touch any
// injected dependency, so a bare prototype instance is enough to exercise it
// without faking IngestionService's 13-odd constructor dependencies.
function makeBareIngestionService(): IngestionService {
  return Object.create(IngestionService.prototype) as IngestionService;
}

describe('formatGmailAfterDate', () => {
  test('formats a UTC date as Gmail\'s after: YYYY/MM/DD shape', () => {
    const date = new Date(Date.UTC(2026, 6, 4)); // July 4, 2026
    assert.equal(formatGmailAfterDate(date), '2026/07/04');
  });

  test('zero-pads single-digit month and day', () => {
    const date = new Date(Date.UTC(2026, 0, 5)); // January 5, 2026
    assert.equal(formatGmailAfterDate(date), '2026/01/05');
  });
});

describe('resolveBackfillWindowDays', () => {
  test('free tier resolves to the 2-month retention window in days', () => {
    assert.equal(resolveBackfillWindowDays('free'), 60);
  });

  test('paid/unlimited tier resolves to the safety cap, not unbounded', () => {
    const days = resolveBackfillWindowDays('paid');
    assert.ok(days > 60, 'paid tier should get more history than free tier');
    assert.ok(Number.isFinite(days), 'paid tier must still be a bounded number of days');
  });
});

describe('resolveTransactionDate', () => {
  test('falls back to receivedAt when no date is found anywhere in the text', () => {
    const service = makeBareIngestionService();
    const receivedAt = new Date('2026-07-04T10:00:00Z');
    const body = 'Your account was debited. No date mentioned here at all.';
    const subject = 'Debit Alert';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (service as any).resolveTransactionDate(undefined, body, subject, receivedAt);

    assert.equal(result.getTime(), receivedAt.getTime());
  });

  test('prefers a labeled date found in the email body over receivedAt', () => {
    const service = makeBareIngestionService();
    const receivedAt = new Date('2026-07-04T10:00:00Z');
    const body = 'Transaction Date: 01/05/2026 10:30\nAmount: NGN 5,000';
    const subject = 'Debit Alert';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (service as any).resolveTransactionDate(undefined, body, subject, receivedAt);

    assert.notEqual(result.getTime(), receivedAt.getTime());
  });
});

describe('scheduleNextPollChunk (chunk-chain cutoff pinning)', () => {
  test('carries connectionId, source, pageToken, and backfillCutoffDate verbatim into the follow-up poll', () => {
    const originalSetTimeout = global.setTimeout;
    let capturedCallback: (() => void) | undefined;
    let capturedDelay: number | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).setTimeout = (cb: () => void, delay: number) => {
      capturedCallback = cb;
      capturedDelay = delay;
      return 0 as unknown as NodeJS.Timeout;
    };

    const service = makeBareIngestionService();
    const calls: unknown[][] = [];
    // Own-property assignment shadows the prototype method, so the arrow
    // function inside scheduleNextPollChunk's setTimeout fallback (which
    // closes over `this.pollConnection`) picks up this spy instead of the
    // real implementation, without needing to fake any of its dependencies.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).pollConnection = async (...args: unknown[]) => {
      calls.push(args);
    };

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).scheduleNextPollChunk(42, 'manual', 'next-page-token-abc', '2026/07/04');

      assert.ok(capturedCallback, 'expected the chunk delay to be scheduled via setTimeout');
      assert.equal(capturedDelay, 60_000);

      capturedCallback!();

      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], [42, 'manual', 'next-page-token-abc', '2026/07/04']);
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });
});
