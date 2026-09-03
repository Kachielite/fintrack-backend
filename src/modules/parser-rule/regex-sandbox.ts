import { Worker } from 'node:worker_threads';
import logger from '@/common/lib/logger';

// isUnsafeRegexPattern (parser-rule.service.ts) is a static check on AI-generated
// patterns before they're saved - it catches obviously dangerous shapes, but a
// pattern that passes it can still exhibit catastrophic backtracking against a
// specific (adversarial or just unlucky) email body at runtime, since regex
// safety in general isn't fully decidable from the pattern text alone. This
// bounds actual execution time as a second, independent line of defense.
//
// Runs each batch of rules in a worker thread (eval'd from a string, not a
// separate file, so it doesn't depend on ts-node vs compiled dist/ path
// resolution) so a hung regex can be forcibly killed via worker.terminate()
// without blocking the main event loop - unlike vm.Script's timeout option,
// which relies on V8 yielding at JS bytecode boundaries and can fail to
// interrupt a regex engine deep in native backtracking.
//
// Batched per template (all of one template's rules against one email body in
// a single round trip) rather than per rule, since spawning a worker per rule
// per template per email would meaningfully add latency to every message. The
// trade-off: if any one rule in a batch hangs, the whole batch's results for
// that email are lost, not just the pathological rule's - acceptable since a
// timeout should be rare, and the affected template is flagged either way.
// See fintrack-backend#167.
//
// A fresh Worker is spawned on every call, and OS thread creation + eval
// compilation can itself take tens of milliseconds - more under the
// ingestion queue's concurrency, where many batches spawn workers at once and
// contend for thread creation. That cost has nothing to do with whether the
// regex itself is safe, so it must not eat into REGEX_EXECUTION_TIMEOUT_MS's
// budget - a template with entirely benign rules could otherwise be
// misclassified as timing out under load. The worker signals 'ready' the
// moment it's alive; only then does the real per-batch timer start and the
// actual payload get sent. See fintrack-backend#185.

const REGEX_WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
parentPort.postMessage({ type: 'ready' });
parentPort.on('message', ({ rules, text }) => {
  const results = rules.map(({ pattern, flags, extractGroup }) => {
    try {
      const regex = new RegExp(pattern, flags);
      const match = regex.exec(text);
      return match && match[extractGroup] ? match[extractGroup] : null;
    } catch {
      return null;
    }
  });
  parentPort.postMessage({ type: 'result', ok: true, results });
});
`;

export interface RegexBatchRule {
  pattern: string;
  flags: string;
  extractGroup: number;
}

export type RegexBatchResult =
  | { timedOut: false; results: (string | null)[] }
  | { timedOut: true; results: null };

// A separate, more generous ceiling on spawn-to-ready time - it only guards
// against a worker that never comes alive at all (a systemic problem, not a
// slow regex), so it's deliberately wide rather than tuned like the
// execution timeout below.
const WORKER_READY_TIMEOUT_MS = 2000;

export function execRuleBatchWithTimeout(
  rules: RegexBatchRule[],
  text: string,
  timeoutMs: number,
): Promise<RegexBatchResult> {
  return new Promise((resolve) => {
    if (rules.length === 0) {
      resolve({ timedOut: false, results: [] });
      return;
    }

    const worker = new Worker(REGEX_WORKER_SOURCE, { eval: true });
    let settled = false;
    let executionTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: RegexBatchResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(readyTimer);
      if (executionTimer) clearTimeout(executionTimer);
      worker.terminate().catch(() => {});
      resolve(result);
    };

    const readyTimer = setTimeout(() => {
      logger.warn(`[RegexSandbox] Worker failed to start within ${WORKER_READY_TIMEOUT_MS}ms - terminating`);
      finish({ timedOut: true, results: null });
    }, WORKER_READY_TIMEOUT_MS);

    worker.on('message', (msg: { type: string; ok?: boolean; results?: (string | null)[] }) => {
      if (msg.type === 'ready') {
        clearTimeout(readyTimer);
        executionTimer = setTimeout(() => {
          logger.warn(`[RegexSandbox] Rule batch timed out after ${timeoutMs}ms (${rules.length} rules) - terminating worker`);
          finish({ timedOut: true, results: null });
        }, timeoutMs);
        worker.postMessage({ rules, text });
        return;
      }
      if (msg.type === 'result') {
        finish(msg.ok ? { timedOut: false, results: msg.results! } : { timedOut: false, results: rules.map(() => null) });
      }
    });
    worker.once('error', (err) => {
      logger.error(`[RegexSandbox] Worker error: ${err}`);
      finish({ timedOut: false, results: rules.map(() => null) });
    });
  });
}
