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

const REGEX_WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
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
  parentPort.postMessage({ ok: true, results });
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

    const finish = (result: RegexBatchResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      resolve(result);
    };

    const timer = setTimeout(() => {
      logger.warn(`[RegexSandbox] Rule batch timed out after ${timeoutMs}ms (${rules.length} rules) - terminating worker`);
      finish({ timedOut: true, results: null });
    }, timeoutMs);

    worker.once('message', (msg: { ok: boolean; results: (string | null)[] }) => {
      finish(msg.ok ? { timedOut: false, results: msg.results } : { timedOut: false, results: rules.map(() => null) });
    });
    worker.once('error', (err) => {
      logger.error(`[RegexSandbox] Worker error: ${err}`);
      finish({ timedOut: false, results: rules.map(() => null) });
    });

    worker.postMessage({ rules, text });
  });
}
