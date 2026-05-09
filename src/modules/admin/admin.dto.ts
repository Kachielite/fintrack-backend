import { z } from 'zod';

export const AdminLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type AdminLoginDTO = z.infer<typeof AdminLoginSchema>;

export const AdminAuthResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.string(),
});

export const AdminChangePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8, 'New password must be at least 8 characters'),
});
export type AdminChangePasswordDTO = z.infer<typeof AdminChangePasswordSchema>;

export const AdminMeResponseSchema = z.object({
  id: z.number(),
  email: z.string(),
});

export const AdminDateRangeSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export type AdminDateRangeDTO = z.infer<typeof AdminDateRangeSchema>;

export const RegexTemplateQuerySchema = z.object({
  page: z.coerce.number().default(1),
  limit: z.coerce.number().default(25),
  status: z.string().optional(),
  bank_id: z.coerce.number().optional(),
  sort_by: z.enum(['confidence_score', 'match_count', 'created_at', 'last_failed_at']).default('created_at'),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});
export type RegexTemplateQueryDTO = z.infer<typeof RegexTemplateQuerySchema>;

export const AdminOverviewResponseSchema = z.object({
  snapshot_at: z.string().datetime(),
  transactions: z.object({
    total_count: z.number(),
    total_count_30d: z.number(),
    handled_by_regex: z.number(),
    handled_by_ai: z.number(),
    regex_rate_pct: z.number(),
    regex_rate_30d_pct: z.number(),
    failed_ingestion_count: z.number(),
    unverified_count: z.number(),
  }),
  regex_engine: z.object({
    total_templates: z.number(),
    production: z.number(),
    candidate: z.number(),
    failed_audit: z.number(),
    degrading: z.number(),
    avg_confidence_score: z.number(),
    banks_with_coverage: z.number(),
    banks_without_coverage: z.number(),
  }),
  users: z.object({
    total: z.number(),
    active_30d: z.number(),
    plan_free: z.number(),
    plan_pro: z.number(),
    plan_premium: z.number(),
    onboarding_complete: z.number(),
    email_connected: z.number(),
  }),
  ingestion: z.object({
    connections_active: z.number(),
    connections_stale: z.number(),
    emails_processed_30d: z.number(),
    emails_failed_30d: z.number(),
    avg_parse_time_ms: z.number().nullable(),
  }),
  ai_cost: z.object({
    estimated_cost_today_usd: z.number(),
    estimated_cost_30d_usd: z.number(),
    total_tokens_30d: z.number(),
    cost_per_transaction_30d: z.number(),
  }),
});
export type AdminOverviewResponseDTO = z.infer<typeof AdminOverviewResponseSchema>;

export const RegexHealthResponseSchema = z.object({
  as_of: z.string().datetime(),
  overall_regex_rate_pct: z.number(),
  trend: z.array(z.object({
    date: z.string(),
    regex_count: z.number(),
    ai_count: z.number(),
    regex_rate_pct: z.number(),
  })),
  by_bank: z.array(z.object({
    bank_id: z.number(),
    bank_name: z.string(),
    short_code: z.string(),
    production_templates: z.number(),
    avg_confidence: z.number(),
    transaction_count_30d: z.number(),
    regex_rate_pct: z.number(),
    correction_rate_pct: z.number(),
    status: z.enum(['healthy', 'degrading', 'no_coverage']),
  })),
  templates_added_30d: z.number(),
  templates_modified_30d: z.number(),
  templates_deprecated_30d: z.number(),
});
export type RegexHealthResponseDTO = z.infer<typeof RegexHealthResponseSchema>;

export const RegexTemplateListSchema = z.object({
  page: z.number(),
  limit: z.number(),
  total_items: z.number(),
  pages: z.number(),
  items: z.array(z.object({
    id: z.number(),
    bank_name: z.string(),
    version: z.number(),
    description: z.string().nullable(),
    status: z.string(),
    confidence_score: z.number(),
    match_count: z.number(),
    fail_count: z.number(),
    correction_count: z.number(),
    created_by: z.string(),
    audit_passed_at: z.string().nullable(),
    promoted_at: z.string().nullable(),
    last_failed_at: z.string().nullable(),
    created_at: z.string(),
  })),
});
export type RegexTemplateListDTO = z.infer<typeof RegexTemplateListSchema>;

export const AuditQueueResponseSchema = z.object({
  total_pending: z.number(),
  items: z.array(z.object({
    template_id: z.number(),
    bank_name: z.string(),
    version: z.number(),
    created_at: z.string(),
    hours_waiting: z.number(),
    triggered_by_tx_id: z.number().nullable(),
  })),
});
export type AuditQueueResponseDTO = z.infer<typeof AuditQueueResponseSchema>;

export const RegexGapsResponseSchema = z.object({
  total_banks_with_gaps: z.number(),
  items: z.array(z.object({
    bank_id: z.number(),
    bank_name: z.string(),
    short_code: z.string(),
    unhandled_tx_count: z.number(),
    oldest_unhandled_at: z.string(),
    candidate_template_exists: z.boolean(),
  })),
});
export type RegexGapsResponseDTO = z.infer<typeof RegexGapsResponseSchema>;

export const RegexCorrectionsResponseSchema = z.object({
  items: z.array(z.object({
    template_id: z.number(),
    bank_name: z.string(),
    description: z.string().nullable(),
    status: z.string(),
    match_count: z.number(),
    correction_count: z.number(),
    correction_rate_pct: z.number(),
    most_corrected_field: z.string().nullable(),
  })),
});
export type RegexCorrectionsResponseDTO = z.infer<typeof RegexCorrectionsResponseSchema>;

export const IngestionHealthResponseSchema = z.object({
  connections: z.object({
    total: z.number(),
    active: z.number(),
    stale: z.number(),
    stale_list: z.array(z.object({
      connection_id: z.number(),
      gmail_address: z.string(),
      last_synced_at: z.string().nullable(),
      status: z.string(),
    })),
  }),
  pipeline_30d: z.object({
    emails_processed: z.number(),
    emails_failed: z.number(),
    failure_rate_pct: z.number(),
    non_transaction_classified: z.number(),
    avg_parse_time_ms: z.number().nullable(),
  }),
  outcomes_30d: z.object({
    parsed: z.number(),
    non_transaction: z.number(),
    failed: z.number(),
  }),
});
export type IngestionHealthResponseDTO = z.infer<typeof IngestionHealthResponseSchema>;

export const IngestionTimelineResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  buckets: z.array(z.object({
    date: z.string(),
    parsed: z.number(),
    failed: z.number(),
    regex_handled: z.number(),
    ai_handled: z.number(),
  })),
});
export type IngestionTimelineResponseDTO = z.infer<typeof IngestionTimelineResponseSchema>;

export const TransactionVolumeResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  totals: z.object({
    count: z.number(),
    debit_count: z.number(),
    credit_count: z.number(),
    total_debit_ref: z.number(),
    total_credit_ref: z.number(),
  }),
  by_bank: z.array(z.object({
    bank_name: z.string(),
    count: z.number(),
    total_ref: z.number(),
    pct_of_total: z.number(),
  })),
  by_currency: z.array(z.object({
    currency: z.string(),
    count: z.number(),
    total_native: z.number(),
    total_ref: z.number(),
  })),
  by_category: z.array(z.object({
    category: z.string(),
    count: z.number(),
    total_ref: z.number(),
    pct_of_total: z.number(),
  })),
});
export type TransactionVolumeResponseDTO = z.infer<typeof TransactionVolumeResponseSchema>;

export const UserStatsResponseSchema = z.object({
  total_users: z.number(),
  new_users_30d: z.number(),
  active_30d: z.number(),
  onboarding_funnel: z.object({
    signed_up: z.number(),
    email_connected: z.number(),
    onboarding_complete: z.number(),
    first_transaction_parsed: z.number(),
  }),
  by_plan: z.object({
    free: z.number(),
    pro: z.number(),
    premium: z.number(),
  }),
  retention: z.object({
    users_with_tx_last_7d: z.number(),
    users_with_tx_last_30d: z.number(),
  }),
});
export type UserStatsResponseDTO = z.infer<typeof UserStatsResponseSchema>;

export const UserRegexStatResponseSchema = z.object({
  user_id: z.number(),
  email: z.string(),
  total_transactions: z.number(),
  handled_by_regex: z.number(),
  handled_by_ai: z.number(),
  regex_rate_pct: z.number(),
  regex_rate_30d_pct: z.number(),
  most_active_bank: z.string().nullable(),
  unverified_count: z.number(),
});
export type UserRegexStatResponseDTO = z.infer<typeof UserRegexStatResponseSchema>;

export const AiUsageResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  totals: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    total_tokens: z.number(),
    estimated_cost_usd: z.number(),
    call_count: z.number(),
  }),
  by_operation: z.array(z.object({
    operation: z.string(),
    call_count: z.number(),
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    total_tokens: z.number(),
    estimated_cost_usd: z.number(),
    pct_of_total_cost: z.number(),
  })),
  trend: z.array(z.object({
    date: z.string(),
    total_tokens: z.number(),
    estimated_cost_usd: z.number(),
    call_count: z.number(),
  })),
  cost_per_transaction_30d: z.number(),
  cost_per_transaction_trend: z.array(z.object({
    date: z.string(),
    cost_per_tx: z.number(),
  })),
});
export type AiUsageResponseDTO = z.infer<typeof AiUsageResponseSchema>;
