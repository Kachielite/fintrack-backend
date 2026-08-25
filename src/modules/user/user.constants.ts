export const FREE_TIER_RETENTION_MONTHS = 2;
export const PAID_TIER_RETENTION_MONTHS = 24;

/**
 * Data-retention window in months for a given plan tier. Computed fresh from
 * planTier rather than trusted from a stored per-user column, so retention
 * behavior can never drift out of sync with the user's actual entitlement.
 */
export function getRetentionMonthsForPlan(planTier: string): number {
  return planTier === 'free' ? FREE_TIER_RETENTION_MONTHS : PAID_TIER_RETENTION_MONTHS;
}
