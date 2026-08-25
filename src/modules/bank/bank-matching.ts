import { IBank } from './bank.interface';

export type DetectionSource =
  | 'exact_sender_email'
  | 'trusted_sender_domain'
  | 'legacy_domain_fallback';

// Full set of ways a bank can end up identified for a given email, including
// the two paths outside bank-matching.ts itself (domain-name heuristic,
// full AI identification) — used to grade template-audit confidence.
export type BankIdentificationSource = DetectionSource | 'domain_name_hint' | 'ai_identified';

export interface BankMatch {
  bank: IBank;
  source: DetectionSource;
}

export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

export function extractDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase().trim();
}

/**
 * Match a sender email against the bank list using a three-tier priority:
 *
 *   1. Exact match in knownSenderEmails         -> exact_sender_email
 *   2. Domain in explicit knownSenderDomains    -> trusted_sender_domain
 *   3. Domain derived from knownSenderEmails    -> legacy_domain_fallback
 *
 * Ambiguous matches (two banks share the same domain in tiers 2 or 3) return
 * null so the caller can fall back to AI identification rather than guess.
 */
export function matchBank(banks: IBank[], email: string): BankMatch | null {
  const normalizedEmail = normalizeEmail(email);
  const senderDomain = extractDomain(normalizedEmail);

  // Tier 1: exact known sender email
  const exact = banks.find((b) =>
    b.knownSenderEmails.some((e) => normalizeEmail(e) === normalizedEmail),
  );
  if (exact) return { bank: exact, source: 'exact_sender_email' };

  if (!senderDomain) return null;

  // Tier 2: explicit trusted sender domain
  const trustedMatches = banks.filter((b) =>
    b.knownSenderDomains.some((d) => d.toLowerCase().trim() === senderDomain),
  );
  if (trustedMatches.length === 1) return { bank: trustedMatches[0], source: 'trusted_sender_domain' };
  if (trustedMatches.length > 1) return null; // ambiguous

  // Tier 3: domain derived from known sender emails (backward compat)
  const legacyMatches = banks.filter((b) =>
    b.knownSenderEmails.some((e) => extractDomain(e) === senderDomain),
  );
  if (legacyMatches.length === 1) return { bank: legacyMatches[0], source: 'legacy_domain_fallback' };

  return null;
}
