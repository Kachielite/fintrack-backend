export const FREE_TIER_RETENTION_MONTHS = 2;
export const PAID_TIER_RETENTION_MONTHS = 24;
export const FREE_TIER_MAX_EMAIL_CONNECTIONS = 1;

/**
 * Data-retention window in months for a given plan tier. Computed fresh from
 * planTier rather than trusted from a stored per-user column, so retention
 * behavior can never drift out of sync with the user's actual entitlement.
 */
export function getRetentionMonthsForPlan(planTier: string): number {
  return planTier === 'free' ? FREE_TIER_RETENTION_MONTHS : PAID_TIER_RETENTION_MONTHS;
}

/**
 * Max simultaneous email connections for a given plan tier. `null` means
 * unlimited. Computed fresh from planTier for the same reason as
 * getRetentionMonthsForPlan above.
 */
export function getMaxEmailConnectionsForPlan(planTier: string): number | null {
  return planTier === 'free' ? FREE_TIER_MAX_EMAIL_CONNECTIONS : null;
}
