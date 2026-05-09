# FinTrack — Admin Endpoints Spec
*Standalone addition to the main backend spec — Claude Code should treat this as a new module alongside the existing ones.*

---

## Authentication

Admin endpoints use a separate authentication mechanism — **not** the standard user JWT. Every admin request must include a custom header:

```
X-Admin-Secret: <ADMIN_SECRET>
```

Add `ADMIN_SECRET` to `CONSTANTS`. The middleware checks this header and returns `401` if it is missing or incorrect. Standard `authenticationMiddleware` does **not** apply to `/admin` routes.

### Admin Middleware (`admin.middleware.ts`)

Create `src/middleware/admin.middleware.ts`:

```typescript
import { Request, Response, NextFunction } from 'express';
import { CONSTANTS } from '@/common/configuration/constants';
import { UnAuthorizedException } from '@/common/exception';

export function adminAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== CONSTANTS.ADMIN_SECRET) {
    throw new UnAuthorizedException('Admin access denied.');
  }
  next();
}
```

Register this middleware **only** on the admin router — not globally. Do not add `/admin` to `authPrefixes` in `authentication.middleware.ts`.

### Environment Variable

```
ADMIN_SECRET=<long-random-string>   # generate with: openssl rand -hex 32
```

---

## Module: `admin`

Single module. One controller, one service, one repository. Requires two new tables: `ai_usage_logs` and `admin_snapshots`.

---

### Router Token

Add to `router.tokens.ts`:

```typescript
ADMIN: Symbol.for('AdminRouter'),
```

Mount at `/admin` in `app.ts`. Apply `adminAuthMiddleware` to the router directly:

```typescript
const adminRouter = container.resolve<Router>(ROUTER_TOKENS.ADMIN);
adminRouter.use(adminAuthMiddleware);
app.use('/admin', adminRouter);
```

---

### Endpoints Overview

| Method | Path | Description |
|---|---|---|
| GET | `/admin/overview` | Platform-level snapshot — one call, full picture |
| GET | `/admin/regex/health` | Regex engine health and coverage |
| GET | `/admin/regex/templates` | Paginated list of all templates with status and scores |
| GET | `/admin/regex/audit-queue` | Candidate templates waiting for audit |
| GET | `/admin/regex/gaps` | Banks with incoming transactions but no production template |
| GET | `/admin/regex/corrections` | Templates with high user correction rates |
| GET | `/admin/ingestion/health` | Pipeline health — success rates, failures, stale connections |
| GET | `/admin/ingestion/timeline` | Transactions processed over time (daily buckets) |
| GET | `/admin/transactions/volume` | Transaction count and value breakdown by bank, currency, category |
| GET | `/admin/users/stats` | User counts, plan distribution, onboarding funnel |
| GET | `/admin/users/:id/regex-stat` | Per-user AI vs regex breakdown (for user-facing transparency) |
| GET | `/admin/ai/usage` | Token consumption and cost breakdown by operation and time period |

---

### Schema (`admin.schema.ts`)

```typescript
// Tracks every OpenAI call made by the system across all services
export const AiUsageLogSchema = pgTable('ai_usage_logs', {
  id: serial('id').primaryKey(),
  operation: text('operation').notNull(), // 'parse_email' | 'generate_template' | 'audit_template' | 'generate_insight' | 'budget_suggestion'
  promptTokens: integer('prompt_tokens').notNull(),
  completionTokens: integer('completion_tokens').notNull(),
  totalTokens: integer('total_tokens').notNull(),
  modelUsed: text('model_used').notNull(),        // e.g. 'gpt-4o'
  userId: integer('user_id').references(() => UserSchema.id, { onDelete: 'set null' }),
  transactionId: integer('transaction_id'),        // nullable — set when operation is 'parse_email'
  templateId: integer('template_id'),              // nullable — set when operation involves a template
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Daily platform snapshots written by cron at 3:00 AM
export const AdminSnapshotSchema = pgTable('admin_snapshots', {
  id: serial('id').primaryKey(),
  snapshotAt: timestamp('snapshot_at').defaultNow().notNull(),
  data: json('data').notNull(),
});
```

#### AI Usage Logging Convention

Every OpenAI call across all services (`IngestionService`, `ParserRuleService`, `InsightGenerationService`, `BudgetService`) must log to `ai_usage_logs` immediately after the call resolves. Use the `usage` field from the OpenAI response object:

```typescript
// After every openai.chat.completions.create() call:
await aiUsageRepository.log({
  operation: 'generate_template',
  promptTokens: response.usage.prompt_tokens,
  completionTokens: response.usage.completion_tokens,
  totalTokens: response.usage.total_tokens,
  modelUsed: response.model,
  userId,       // pass through from calling context where available
  templateId,   // pass through where relevant
});
```

Create `AiUsageRepository` as a singleton and inject it into every service that calls OpenAI.

#### Cost Calculation Utility

Add `src/common/utils/cost-calculator.ts`. Add the pricing constants to `CONSTANTS` so they can be updated without a code change if OpenAI pricing changes:

```
# .env
OPENAI_COST_PER_1K_INPUT_TOKENS=0.0025    # GPT-4o input, USD
OPENAI_COST_PER_1K_OUTPUT_TOKENS=0.010    # GPT-4o output, USD
```

```typescript
// src/common/utils/cost-calculator.ts
export function calculateCostUsd(promptTokens: number, completionTokens: number): number {
  const inputCost  = (promptTokens / 1000) * CONSTANTS.OPENAI_COST_PER_1K_INPUT_TOKENS;
  const outputCost = (completionTokens / 1000) * CONSTANTS.OPENAI_COST_PER_1K_OUTPUT_TOKENS;
  return parseFloat((inputCost + outputCost).toFixed(6));
}
```

Cost is always computed at query time from stored token counts — never stored as a column. This means if pricing changes you can recalculate all historical cost accurately by updating `CONSTANTS` alone.

---

### DTOs (`admin.dto.ts`)

```typescript
// Shared query params for date range filtering
export const AdminDateRangeSchema = z.object({
  from: z.string().datetime().optional(),   // defaults to 30 days ago
  to: z.string().datetime().optional(),     // defaults to now
});

// GET /admin/overview
export const AdminOverviewResponseSchema = z.object({
  snapshot_at: z.string().datetime(),
  transactions: z.object({
    total_count: z.number(),
    total_count_30d: z.number(),
    handled_by_regex: z.number(),           // lifetime
    handled_by_ai: z.number(),              // lifetime
    regex_rate_pct: z.number(),             // handled_by_regex / total * 100
    regex_rate_30d_pct: z.number(),         // same but last 30 days — shows trend
    failed_ingestion_count: z.number(),
    unverified_count: z.number(),           // transactions still awaiting review
  }),
  regex_engine: z.object({
    total_templates: z.number(),
    production: z.number(),
    candidate: z.number(),                  // awaiting audit
    failed_audit: z.number(),               // needs attention
    degrading: z.number(),                  // confidence dropped below reaudit threshold
    avg_confidence_score: z.number(),
    banks_with_coverage: z.number(),
    banks_without_coverage: z.number(),     // have transactions but no production template
  }),
  users: z.object({
    total: z.number(),
    active_30d: z.number(),                 // users with at least one transaction in 30 days
    plan_free: z.number(),
    plan_pro: z.number(),
    plan_premium: z.number(),
    onboarding_complete: z.number(),
    email_connected: z.number(),
  }),
  ingestion: z.object({
    connections_active: z.number(),
    connections_stale: z.number(),          // token expired or last sync > 24h ago
    emails_processed_30d: z.number(),
    emails_failed_30d: z.number(),
    avg_parse_time_ms: z.number().nullable(),
  }),
  ai_cost: z.object({
    estimated_cost_today_usd: z.number(),
    estimated_cost_30d_usd: z.number(),
    total_tokens_30d: z.number(),
    cost_per_transaction_30d: z.number(),   // total AI cost / total transactions — falls as regexes take over
  }),
});

// GET /admin/regex/health
export const RegexHealthResponseSchema = z.object({
  as_of: z.string().datetime(),
  overall_regex_rate_pct: z.number(),
  trend: z.array(z.object({
    // Daily AI vs regex split for the past N days — used to plot the handoff trend line
    date: z.string(),                       // 'YYYY-MM-DD'
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
    correction_rate_pct: z.number(),        // user corrections / total parsed by regex
    status: z.enum(['healthy', 'degrading', 'no_coverage']),
  })),
  templates_added_30d: z.number(),
  templates_modified_30d: z.number(),       // promoted to new version
  templates_deprecated_30d: z.number(),
});

// GET /admin/regex/templates
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
    correction_count: z.number(),           // times a user corrected a tx parsed by this template
    created_by: z.string(),
    audit_passed_at: z.string().nullable(),
    promoted_at: z.string().nullable(),
    last_failed_at: z.string().nullable(),
    created_at: z.string(),
  })),
});

export const RegexTemplateQuerySchema = z.object({
  page: z.coerce.number().default(1),
  limit: z.coerce.number().default(25),
  status: z.string().optional(),            // filter by RuleStatusEnum
  bank_id: z.coerce.number().optional(),
  sort_by: z.enum(['confidence_score', 'match_count', 'created_at', 'last_failed_at']).default('created_at'),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

// GET /admin/regex/audit-queue
export const AuditQueueResponseSchema = z.object({
  total_pending: z.number(),
  items: z.array(z.object({
    template_id: z.number(),
    bank_name: z.string(),
    version: z.number(),
    created_at: z.string(),
    hours_waiting: z.number(),              // time since candidate was created
    triggered_by_tx_id: z.number().nullable(),
  })),
});

// GET /admin/regex/gaps
export const RegexGapsResponseSchema = z.object({
  total_banks_with_gaps: z.number(),
  items: z.array(z.object({
    bank_id: z.number(),
    bank_name: z.string(),
    short_code: z.string(),
    unhandled_tx_count: z.number(),         // transactions still parsed by AI, no production template
    oldest_unhandled_at: z.string(),
    candidate_template_exists: z.boolean(), // a template is in progress but not yet promoted
  })),
});

// GET /admin/regex/corrections
export const RegexCorrectionsResponseSchema = z.object({
  items: z.array(z.object({
    template_id: z.number(),
    bank_name: z.string(),
    description: z.string().nullable(),
    status: z.string(),
    match_count: z.number(),
    correction_count: z.number(),
    correction_rate_pct: z.number(),        // correction_count / match_count * 100
    most_corrected_field: z.string().nullable(), // 'merchant' | 'category' | 'amount' — most common correction type
  })),
});

// GET /admin/ingestion/health
export const IngestionHealthResponseSchema = z.object({
  connections: z.object({
    total: z.number(),
    active: z.number(),
    stale: z.number(),                      // last_synced_at > 24h or token expired
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
    non_transaction_classified: z.number(), // correctly discarded non-tx emails
    avg_parse_time_ms: z.number().nullable(),
  }),
  outcomes_30d: z.object({
    parsed: z.number(),
    non_transaction: z.number(),
    failed: z.number(),
  }),
});

// GET /admin/ingestion/timeline
export const IngestionTimelineResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  buckets: z.array(z.object({
    date: z.string(),                       // 'YYYY-MM-DD'
    parsed: z.number(),
    failed: z.number(),
    regex_handled: z.number(),
    ai_handled: z.number(),
  })),
});

// GET /admin/transactions/volume
export const TransactionVolumeResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  totals: z.object({
    count: z.number(),
    debit_count: z.number(),
    credit_count: z.number(),
    total_debit_ref: z.number(),            // total debit value in NGN (or platform ref currency)
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
    total_native: z.number(),               // sum in original currency
    total_ref: z.number(),                  // sum converted to ref currency
  })),
  by_category: z.array(z.object({
    category: z.string(),
    count: z.number(),
    total_ref: z.number(),
    pct_of_total: z.number(),
  })),
});

// GET /admin/users/stats
export const UserStatsResponseSchema = z.object({
  total_users: z.number(),
  new_users_30d: z.number(),
  active_30d: z.number(),
  onboarding_funnel: z.object({
    signed_up: z.number(),
    email_connected: z.number(),            // completed step A
    onboarding_complete: z.number(),        // completed step B (goal set)
    first_transaction_parsed: z.number(),   // had at least one transaction ingested
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

// GET /admin/users/:id/regex-stat
// Used to compute the per-user transparency stat shown on their profile screen
export const UserRegexStatResponseSchema = z.object({
  user_id: z.number(),
  email: z.string(),
  total_transactions: z.number(),
  handled_by_regex: z.number(),
  handled_by_ai: z.number(),
  regex_rate_pct: z.number(),
  // Trend: last 30 days vs all time — shows if the user's regex rate is improving
  regex_rate_30d_pct: z.number(),
  most_active_bank: z.string().nullable(),
  unverified_count: z.number(),            // transactions still needing review
});

// GET /admin/ai/usage
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
  // Daily buckets — plots token spend and cost over time
  trend: z.array(z.object({
    date: z.string(),                       // 'YYYY-MM-DD'
    total_tokens: z.number(),
    estimated_cost_usd: z.number(),
    call_count: z.number(),
  })),
  // Key efficiency metric — should fall over time as regexes displace AI calls
  cost_per_transaction_30d: z.number(),
  cost_per_transaction_trend: z.array(z.object({
    date: z.string(),
    cost_per_tx: z.number(),
  })),
});
```

---

### Service Notes (`admin.service.ts`)

**`getOverview()`** — single aggregation query across `transactions`, `parser_templates`, `users`, `email_connections`, `processed_emails`, and `ai_usage_logs`. Compute `regex_rate_pct` as:
```
(transactions where parser_template_id IS NOT NULL AND status = 'verified') / total * 100
```
Transactions with `status = 'unverified'` or `parser_template_id IS NULL` count as AI-handled. For `ai_cost`, sum `ai_usage_logs` for today and for the last 30 days, then pass through `calculateCostUsd()`.

**`getRegexHealth(dateRange)`** — the `trend` array is the most important field. Query `processed_emails` grouped by day and by whether the resulting transaction was regex-handled or AI-handled. This produces the handoff trend line that shows the engine improving over time.

**`getRegexCorrections()`** — join `transactions` where `status = 'corrected'` back to `parser_template_id`. Group by template. To determine `most_corrected_field`, compare `original_merchant` vs `merchant`, `original_category` vs `category` on corrected transactions and count which field changed most often.

**`getIngestionHealth()`** — `stale` connections are defined as: `status = 'active'` AND (`last_synced_at` is null OR `last_synced_at < NOW - INTERVAL '24 hours'`).

**`getAiUsage(dateRange)`** — query `ai_usage_logs` for the period. Compute `estimated_cost_usd` for each row using `calculateCostUsd(promptTokens, completionTokens)` and aggregate. For `cost_per_transaction_30d`: divide total AI cost in the last 30 days by total transaction count in the same period. For `cost_per_transaction_trend`: compute this ratio per day bucket — this is the key efficiency metric and should trend downward as regex coverage grows.

**`getUserRegexStat(userId)`** — this is also the computation that powers the user-facing transparency stat. The service method should be reusable from a future user-facing endpoint if you decide to expose it on the profile screen.

---

### Daily Admin Snapshot Cron

Add a daily cron at 3:00 AM that calls `AdminService.getOverview()` and writes the result to `admin_snapshots`. The snapshot's `data` field includes the `ai_cost` block, giving a daily record of AI spend alongside platform health — all without querying live data retroactively.

No endpoint needed for this immediately — it's internal storage. Add a `GET /admin/snapshots` endpoint later if you want to build a trend dashboard.
