export enum InsightTypeEnum {
  REPORT = 'report',
  // Legacy types — no longer produced by generateForUser (see BE2-3), kept
  // so historical rows remain typed correctly.
  SPENDING_PATTERN = 'spending_pattern',
  BUDGET_WARNING = 'budget_warning',
  GOAL_PROGRESS = 'goal_progress',
  FX_IMPACT = 'fx_impact',
  SUBSCRIPTION_ALERT = 'subscription_alert',
  POSITIVE_REINFORCEMENT = 'positive_reinforcement',
}
