import 'reflect-metadata';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import IngestionService, {
  formatGmailAfterDate,
  resolveBackfillWindowDays,
} from '../src/modules/ingestion/ingestion.service';
import { RateLimitedExtractionError, ParsedTransaction } from '../src/modules/parser-rule/parser-rule.interface';

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

describe('parseDateCandidate', () => {
  test('treats an ambiguous dd/mm slash date as day-first, not native Date()\'s month-first', () => {
    const service = makeBareIngestionService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (service as any).parseDateCandidate('04/05/2025');
    // "04/05/2025" day-first means 4 May 2025, not April 4/5 (native Date()'s
    // MM/DD/YYYY interpretation) — see fintrack-backend#161.
    const expected = new Date(2025, 4, 4); // month index 4 = May
    assert.equal(result.getTime(), expected.getTime());
  });

  test('applies the same day-first rule with a time component', () => {
    const service = makeBareIngestionService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (service as any).parseDateCandidate('04/05/2025 10:30');
    const expected = new Date(2025, 4, 4, 10, 30, 0);
    assert.equal(result.getTime(), expected.getTime());
  });

  test('still parses an unambiguous day>12 slash date correctly (day-first was already reachable here)', () => {
    const service = makeBareIngestionService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (service as any).parseDateCandidate('25/03/2025');
    const expected = new Date(2025, 2, 25); // 25 March 2025
    assert.equal(result.getTime(), expected.getTime());
  });

  test('still parses ISO-format dates via the native Date() fallback, unaffected', () => {
    const service = makeBareIngestionService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (service as any).parseDateCandidate('2025-05-04T10:30:00Z');
    assert.equal(result.toISOString(), '2025-05-04T10:30:00.000Z');
  });

  test('still parses month-name dates via the native Date() fallback, unaffected', () => {
    const service = makeBareIngestionService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (service as any).parseDateCandidate('04 May 2025');
    assert.equal(result.getFullYear(), 2025);
    assert.equal(result.getMonth(), 4); // May
    assert.equal(result.getDate(), 4);
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
    // 2 days before receivedAt - plausible, within fintrack-backend#162's tolerance.
    const body = 'Transaction Date: 02/07/2026 10:30\nAmount: NGN 5,000';
    const subject = 'Debit Alert';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (service as any).resolveTransactionDate(undefined, body, subject, receivedAt);

    assert.notEqual(result.getTime(), receivedAt.getTime());
  });

  test('rejects a future-dated candidate and falls back to receivedAt', () => {
    const service = makeBareIngestionService();
    const receivedAt = new Date('2026-07-04T10:00:00Z');
    // Well beyond the plausibility window ahead of receivedAt - a bank alert
    // can't report a transaction that hasn't happened yet.
    const body = 'Transaction Date: 15/09/2026 10:00\nAmount: NGN 5,000';
    const subject = 'Debit Alert';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (service as any).resolveTransactionDate(undefined, body, subject, receivedAt);

    assert.equal(result.getTime(), receivedAt.getTime());
  });

  test('rejects a candidate implausibly far in the past and falls back to receivedAt', () => {
    const service = makeBareIngestionService();
    const receivedAt = new Date('2026-07-04T10:00:00Z');
    // A regex/AI grab on a stray old date (footer, copyright, unrelated promo
    // text) years before the email actually arrived.
    const body = 'Transaction Date: 01/01/2020 10:00\nAmount: NGN 5,000';
    const subject = 'Debit Alert';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (service as any).resolveTransactionDate(undefined, body, subject, receivedAt);

    assert.equal(result.getTime(), receivedAt.getTime());
  });

  test('accepts a candidate within the plausibility tolerance of receivedAt', () => {
    const service = makeBareIngestionService();
    const receivedAt = new Date('2026-07-04T10:00:00Z');
    // One day before receivedAt - well within tolerance, should be accepted as-is.
    const body = 'Transaction Date: 03/07/2026 09:00\nAmount: NGN 5,000';
    const subject = 'Debit Alert';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (service as any).resolveTransactionDate(undefined, body, subject, receivedAt);

    assert.notEqual(result.getTime(), receivedAt.getTime());
    assert.equal(result.getFullYear(), 2026);
    assert.equal(result.getMonth(), 6); // July
    assert.equal(result.getDate(), 3);
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

describe('shadowVerifyTemplateMatch', () => {
  const REGEX_RESULT: ParsedTransaction = {
    amount: 5000,
    transactionType: 'debit',
    date: '03/07/2026 09:00',
    merchant: 'Jumia Nigeria',
  };
  const RECEIVED_AT = new Date('2026-07-04T10:00:00Z');

  function makeServiceWithFakeParserRule(extractTransactionImpl: () => Promise<ParsedTransaction | null>) {
    const service = makeBareIngestionService();
    const recordFailureCalls: number[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).parserRuleService = {
      extractTransaction: extractTransactionImpl,
      recordFailure: async (templateId: number) => {
        recordFailureCalls.push(templateId);
      },
    };
    return { service, recordFailureCalls };
  }

  test('records a failure when the AI-extracted amount diverges from the regex amount', async () => {
    const { service, recordFailureCalls } = makeServiceWithFakeParserRule(async () => ({
      ...REGEX_RESULT,
      amount: 9999, // diverges from REGEX_RESULT's 5000
    }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (service as any).shadowVerifyTemplateMatch(42, 'GTBank', 'body', 'subject', REGEX_RESULT, RECEIVED_AT, []);

    assert.deepEqual(recordFailureCalls, [42]);
  });

  test('does not record a failure when the AI result closely matches the regex result', async () => {
    const { service, recordFailureCalls } = makeServiceWithFakeParserRule(async () => ({
      ...REGEX_RESULT,
      merchant: 'JUMIA', // normalizes to a substring match of "Jumia Nigeria"
    }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (service as any).shadowVerifyTemplateMatch(42, 'GTBank', 'body', 'subject', REGEX_RESULT, RECEIVED_AT, []);

    assert.deepEqual(recordFailureCalls, []);
  });

  test('does not record a failure when AI extraction is rate-limited (inconclusive)', async () => {
    const { service, recordFailureCalls } = makeServiceWithFakeParserRule(async () => {
      throw new RateLimitedExtractionError('rate limited');
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (service as any).shadowVerifyTemplateMatch(42, 'GTBank', 'body', 'subject', REGEX_RESULT, RECEIVED_AT, []);

    assert.deepEqual(recordFailureCalls, []);
  });

  test('does not record a failure when AI extraction returns null (not conclusive either way)', async () => {
    const { service, recordFailureCalls } = makeServiceWithFakeParserRule(async () => null);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (service as any).shadowVerifyTemplateMatch(42, 'GTBank', 'body', 'subject', REGEX_RESULT, RECEIVED_AT, []);

    assert.deepEqual(recordFailureCalls, []);
  });

  test('records a failure when the transaction type diverges', async () => {
    const { service, recordFailureCalls } = makeServiceWithFakeParserRule(async () => ({
      ...REGEX_RESULT,
      transactionType: 'credit', // diverges from REGEX_RESULT's debit
    }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (service as any).shadowVerifyTemplateMatch(42, 'GTBank', 'body', 'subject', REGEX_RESULT, RECEIVED_AT, []);

    assert.deepEqual(recordFailureCalls, [42]);
  });
});
