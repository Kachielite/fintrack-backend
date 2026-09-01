export const FREE_TIER_RETENTION_MONTHS = 2;
export const FREE_TIER_MAX_EMAIL_CONNECTIONS = 1;

/**
 * How far back a given plan tier can query/see transaction history, in
 * months. `null` means unlimited (paid tier can query as far back as the
 * system has data). Computed fresh from planTier rather than trusted from a
 * stored per-user column, so this can never drift out of sync with the
 * user's actual entitlement. This gates query visibility only — data is
 * never deleted for retention reasons.
 */
export function getRetentionMonthsForPlan(planTier: string): number | null {
  return planTier === 'free' ? FREE_TIER_RETENTION_MONTHS : null;
}

/**
 * Max simultaneous email connections for a given plan tier. `null` means
 * unlimited. Computed fresh from planTier for the same reason as
 * getRetentionMonthsForPlan above.
 */
export function getMaxEmailConnectionsForPlan(planTier: string): number | null {
  return planTier === 'free' ? FREE_TIER_MAX_EMAIL_CONNECTIONS : null;
}
