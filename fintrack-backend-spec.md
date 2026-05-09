# FinTrack — Backend Specification
*For Claude Code — Express + TypeScript*

Read `EXPRESS_PROJECT_GUIDE.md` in full before writing any code. Every architectural decision, file naming convention, DI pattern, error class, and response shape defined there takes precedence over any general Express convention.

---

## Stack & Integrations

| Concern | Library / Service |
|---|---|
| Runtime | Node.js + TypeScript (EXPRESS_PROJECT_GUIDE conventions) |
| Framework | Express 5 |
| ORM | Drizzle ORM + PostgreSQL |
| Validation | Zod |
| Auth | JWT + Google OAuth 2.0 + Apple Sign-In |
| Email ingestion | Gmail API (`googleapis`) |
| AI parsing | OpenAI GPT-4o (`openai` SDK) |
| Exchange rates | Open Exchange Rates API (free tier) |
| Encryption | Node.js `crypto` (AES-256-GCM) for OAuth tokens at rest |
| Background jobs | `node-cron` for scheduled Gmail polling |

---

## Environment Variables

Add all of these to `CONSTANTS` in `src/common/configuration/constants.ts`:

```
PORT
DATABASE_URL
JWT_SECRET
JWT_EXPIRES_IN

# Google OAuth
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI

# Apple Sign-In
APPLE_CLIENT_ID
APPLE_TEAM_ID
APPLE_KEY_ID
APPLE_PRIVATE_KEY

# OpenAI
OPENAI_API_KEY
OPENAI_MODEL=gpt-4o

# Exchange rates
OPEN_EXCHANGE_RATES_APP_ID

# Encryption key for stored OAuth tokens (32-byte hex)
TOKEN_ENCRYPTION_KEY

# Gmail polling interval in minutes
GMAIL_POLL_INTERVAL_MINUTES=15

# Regex confidence thresholds
REGEX_PRODUCTION_THRESHOLD=0.85
REGEX_REAUDIT_THRESHOLD=0.60

FRONTEND_ORIGIN
```

---

## Modules

Build the following modules. Each follows the full `EXPRESS_PROJECT_GUIDE` pattern: `.enum.ts` → `.interface.ts` → `.schema.ts` → `.dto.ts` → `.repository.ts` → `.service.ts` → `.controller.ts` → `.dependencies.ts`.

---

### Module 1: `auth`

Handles Google OAuth, Apple Sign-In, JWT issuance, and token refresh. No email/password authentication.

#### Enums (`auth.enum.ts`)
```typescript
export enum AuthProviderEnum {
  GOOGLE = 'google',
  APPLE = 'apple',
}
```

#### Drizzle Schema (`auth.schema.ts`)
```typescript
// auth_providers table — links a user to their OAuth identities
export const AuthProviderSchema = pgTable('auth_providers', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => UserSchema.id, { onDelete: 'cascade' }).notNull(),
  provider: text('provider').notNull(),           // 'google' | 'apple'
  providerUserId: text('provider_user_id').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
```

#### DTOs (`auth.dto.ts`)
```typescript
// POST /auth/google
export const GoogleAuthSchema = z.object({
  id_token: z.string().min(1),
});

// POST /auth/apple
export const AppleAuthSchema = z.object({
  id_token: z.string().min(1),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
});

// POST /auth/refresh
export const RefreshTokenSchema = z.object({
  refresh_token: z.string().min(1),
});

// Response
export const AuthResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  user: z.object({
    id: z.number(),
    email: z.string(),
    first_name: z.string(),
    onboarding_complete: z.boolean(),
  }),
});
```

#### Routes
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/google` | ❌ | Verify Google `id_token`, upsert user, return JWT pair |
| POST | `/auth/apple` | ❌ | Verify Apple `id_token`, upsert user, return JWT pair |
| POST | `/auth/refresh` | ❌ | Exchange refresh token for new access token |
| POST | `/auth/logout` | ✅ | Invalidate refresh token |

#### Service Notes
- Verify Google `id_token` using `google-auth-library` `OAuth2Client.verifyIdToken()`.
- Verify Apple `id_token` by fetching Apple's public keys from `https://appleid.apple.com/auth/keys` and validating the JWT.
- On first sign-in: create a `User` record and an `AuthProvider` record. On subsequent sign-ins: find by `provider` + `providerUserId`, return existing user.
- Issue two JWTs: a short-lived `access_token` (15 min) and a long-lived `refresh_token` (30 days). Store a hash of the refresh token on the user record for invalidation.
- `onboarding_complete` is `false` until the user has completed both onboarding steps (Gmail connected + goal set).

---

### Module 2: `user`

Stores user profiles and onboarding preferences.

#### Enums (`user.enum.ts`)
```typescript
export enum GoalTypeEnum {
  SAVE = 'save',
  DEBT = 'debt',
  DAILY = 'daily',
  SPECIFIC = 'specific',
}

export enum PayFrequencyEnum {
  WEEKLY = 'weekly',
  BIWEEKLY = 'biweekly',
  MONTHLY = 'monthly',
  IRREGULAR = 'irregular',
}

export enum AdvisorToneEnum {
  WARM = 'warm',
  DIRECT = 'direct',
  BRIEF = 'brief',
}

export enum CurrencyEnum {
  NGN = 'NGN',
  USD = 'USD',
  GBP = 'GBP',
  KES = 'KES',
  EUR = 'EUR',
  GHS = 'GHS',
  ZAR = 'ZAR',
}
```

#### Drizzle Schema (`user.schema.ts`)
```typescript
export const UserSchema = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  firstName: text('first_name').notNull(),
  lastName: text('last_name'),
  refCurrency: text('ref_currency').default('NGN').notNull(),
  advisorTone: text('advisor_tone').default('warm').notNull(),
  goalType: text('goal_type'),
  incomeRange: text('income_range'),         // e.g. '600k-1.5M' — stored as label string
  payFrequency: text('pay_frequency'),
  onboardingComplete: boolean('onboarding_complete').default(false).notNull(),
  refreshTokenHash: text('refresh_token_hash'),
  planTier: text('plan_tier').default('free').notNull(), // 'free' | 'pro' | 'premium'
  dataRetentionMonths: integer('data_retention_months').default(3).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
```

#### DTOs (`user.dto.ts`)
```typescript
export const UpdateUserSchema = z.object({
  first_name: z.string().min(1).optional(),
  last_name: z.string().optional(),
  ref_currency: z.nativeEnum(CurrencyEnum).optional(),
  advisor_tone: z.nativeEnum(AdvisorToneEnum).optional(),
});

export const CompleteOnboardingSchema = z.object({
  goal_type: z.nativeEnum(GoalTypeEnum),
  income_range: z.string().min(1),
  pay_frequency: z.nativeEnum(PayFrequencyEnum),
  ref_currency: z.nativeEnum(CurrencyEnum),
});

export const UserResponseSchema = z.object({
  id: z.number(),
  email: z.string(),
  first_name: z.string(),
  last_name: z.string().nullable(),
  ref_currency: z.string(),
  advisor_tone: z.string(),
  goal_type: z.string().nullable(),
  income_range: z.string().nullable(),
  pay_frequency: z.string().nullable(),
  onboarding_complete: z.boolean(),
  plan_tier: z.string(),
  created_at: z.date(),
});
```

#### Routes
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/users/me` | ✅ | Get current user profile |
| PATCH | `/users/me` | ✅ | Update profile fields |
| POST | `/users/me/onboarding` | ✅ | Complete onboarding step B (goal + income). Sets `onboarding_complete = true` |
| DELETE | `/users/me` | ✅ | Delete account and all associated data |

---

### Module 3: `email-connection`

Manages Gmail OAuth connections and the label configuration for each user.

#### Enums (`email-connection.enum.ts`)
```typescript
export enum EmailProviderEnum {
  GMAIL = 'gmail',
}

export enum ConnectionStatusEnum {
  ACTIVE = 'active',
  EXPIRED = 'expired',
  REVOKED = 'revoked',
}
```

#### Drizzle Schema (`email-connection.schema.ts`)
```typescript
export const EmailConnectionSchema = pgTable('email_connections', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => UserSchema.id, { onDelete: 'cascade' }).notNull(),
  provider: text('provider').default('gmail').notNull(),
  gmailAddress: text('gmail_address').notNull(),
  // Tokens stored AES-256-GCM encrypted. Never stored in plaintext.
  encryptedAccessToken: text('encrypted_access_token').notNull(),
  encryptedRefreshToken: text('encrypted_refresh_token').notNull(),
  tokenExpiresAt: timestamp('token_expires_at').notNull(),
  gmailLabelId: text('gmail_label_id'),          // set after user confirms label
  gmailLabelName: text('gmail_label_name').default('Bank Transactions'),
  status: text('status').default('active').notNull(),
  lastSyncedAt: timestamp('last_synced_at'),
  lastSyncMessageCount: integer('last_sync_message_count').default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
```

#### DTOs (`email-connection.dto.ts`)
```typescript
// POST /email-connections/google/callback — receives code from OAuth flow
export const GmailCallbackSchema = z.object({
  code: z.string().min(1),
  redirect_uri: z.string().url(),
});

// PATCH /email-connections/:id/label
export const SetLabelSchema = z.object({
  label_id: z.string().min(1),
  label_name: z.string().min(1),
});

// Response
export const EmailConnectionResponseSchema = z.object({
  id: z.number(),
  gmail_address: z.string(),
  status: z.string(),
  gmail_label_id: z.string().nullable(),
  gmail_label_name: z.string().nullable(),
  last_synced_at: z.date().nullable(),
  created_at: z.date(),
});

// GET /email-connections/:id/labels — list Gmail labels for picker
export const GmailLabelSchema = z.object({
  id: z.string(),
  name: z.string(),
  messages_total: z.number().optional(),
});
```

#### Routes
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/email-connections/google/auth-url` | ✅ | Generate Google OAuth URL with Gmail readonly scope |
| POST | `/email-connections/google/callback` | ✅ | Exchange OAuth code for tokens, store encrypted, create connection record |
| GET | `/email-connections` | ✅ | List user's email connections |
| GET | `/email-connections/:id` | ✅ | Get single connection |
| GET | `/email-connections/:id/labels` | ✅ | Fetch user's Gmail labels (for the label picker UI) |
| PATCH | `/email-connections/:id/label` | ✅ | Set the Gmail label to monitor |
| POST | `/email-connections/:id/sync` | ✅ | Trigger a manual sync for this connection |
| DELETE | `/email-connections/:id` | ✅ | Revoke and remove connection. Revoking calls Google's token revocation endpoint. |

#### Service Notes
- Use `googleapis` `google.auth.OAuth2` for the OAuth flow. Request only `https://www.googleapis.com/auth/gmail.readonly` scope.
- Encrypt/decrypt tokens using `TokenEncryptionService` (a utility class using Node.js `crypto`, AES-256-GCM, with `TOKEN_ENCRYPTION_KEY` from CONSTANTS). Keep this service in `src/common/utils/token-encryption.ts`.
- Token refresh: before each Gmail API call, check `tokenExpiresAt`. If expired, call `oauth2Client.refreshAccessToken()`, re-encrypt, and update the record.
- The `/labels` endpoint calls Gmail API `users.labels.list` and returns the full list so the frontend can show a picker. Filter out system labels (those starting with `CATEGORY_`, `CHAT`, `SENT`, `INBOX` etc.).
- On DELETE: call `https://oauth2.googleapis.com/revoke?token=<access_token>` before removing the record.

---

### Module 4: `bank`

A shared registry of known banks and their email sender addresses. Used by the parser engine to route incoming emails to the right rule set.

#### Drizzle Schema (`bank.schema.ts`)
```typescript
export const BankSchema = pgTable('banks', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  shortCode: text('short_code').notNull().unique(), // e.g. 'gtbank', 'kuda', 'wise'
  country: text('country'),                          // ISO 3166-1 alpha-2
  knownSenderEmails: text('known_sender_emails').array().notNull().default([]),
  logoUrl: text('logo_url'),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
```

#### Routes
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/banks` | ✅ | List all active banks |
| GET | `/banks/:id` | ✅ | Get single bank |

#### Seed Data
Seed the following banks on first migration:

| name | shortCode | knownSenderEmails |
|---|---|---|
| GTBank | gtbank | `noreply@gtbank.com`, `alerts@gtbank.com` |
| Kuda Bank | kuda | `noreply@kuda.com`, `hello@kuda.com` |
| Wise | wise | `notification@wise.com` |
| Access Bank | access | `alerts@accessbankplc.com` |
| Zenith Bank | zenith | `alerts@zenithbank.com` |
| Monzo | monzo | `noreply@monzo.com` |
| Stanbic IBTC | stanbic | `ibtcalerts@stanbicibtc.com` |
| Sterling Bank | sterling | `alerts@sterling.ng` |
| Ecobank | ecobank | `ecobank@ecobank.com` |

---

### Module 5: `parser-rule`

The self-improving regex engine. Each rule is a regex pattern that extracts a specific field from a bank's email body. Rules are versioned per bank and go through a lifecycle: `candidate` → `audited` → `production` → `deprecated`.

#### Enums (`parser-rule.enum.ts`)
```typescript
export enum RuleStatusEnum {
  CANDIDATE = 'candidate',     // AI-generated, not yet audited
  AUDITED = 'audited',         // Passed AI audit, ready for production
  PRODUCTION = 'production',   // Active — used for all matching transactions
  DEPRECATED = 'deprecated',   // Replaced by a newer version
  FAILED_AUDIT = 'failed_audit', // Did not pass AI audit
}

export enum RuleFieldEnum {
  AMOUNT = 'amount',
  CURRENCY = 'currency',
  MERCHANT = 'merchant',
  TRANSACTION_TYPE = 'transaction_type', // debit | credit
  DATE = 'date',
  BALANCE = 'balance',
  REFERENCE = 'reference',
}

export enum RuleCreatorEnum {
  AI = 'ai',
  MANUAL = 'manual',
}
```

#### Drizzle Schema (`parser-rule.schema.ts`)
```typescript
export const ParserRuleSchema = pgTable('parser_rules', {
  id: serial('id').primaryKey(),
  bankId: integer('bank_id').references(() => BankSchema.id, { onDelete: 'cascade' }).notNull(),
  version: integer('version').default(1).notNull(),
  field: text('field').notNull(),                // RuleFieldEnum value
  pattern: text('pattern').notNull(),            // regex string
  flags: text('flags').default('i').notNull(),   // regex flags
  extractGroup: integer('extract_group').default(1).notNull(), // capture group index
  status: text('status').default('candidate').notNull(),
  confidenceScore: real('confidence_score').default(0).notNull(), // 0.0 – 1.0
  matchCount: integer('match_count').default(0).notNull(),
  failCount: integer('fail_count').default(0).notNull(),
  createdBy: text('created_by').default('ai').notNull(),
  auditNotes: text('audit_notes'),
  auditPassedAt: timestamp('audit_passed_at'),
  promotedAt: timestamp('promoted_at'),
  deprecatedAt: timestamp('deprecated_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// A full parsing template groups all field rules for one bank's email format
export const ParserTemplateSchema = pgTable('parser_templates', {
  id: serial('id').primaryKey(),
  bankId: integer('bank_id').references(() => BankSchema.id, { onDelete: 'cascade' }).notNull(),
  version: integer('version').default(1).notNull(),
  description: text('description'),             // e.g. 'GTBank debit alert v2'
  emailSubjectPattern: text('email_subject_pattern'), // optional regex to match subject
  status: text('status').default('candidate').notNull(),
  confidenceScore: real('confidence_score').default(0).notNull(),
  matchCount: integer('match_count').default(0).notNull(),
  failCount: integer('fail_count').default(0).notNull(),
  lastFailedAt: timestamp('last_failed_at'),    // detect silent breakage
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Junction: template → rules
export const TemplateRuleSchema = pgTable('template_rules', {
  templateId: integer('template_id').references(() => ParserTemplateSchema.id, { onDelete: 'cascade' }).notNull(),
  ruleId: integer('rule_id').references(() => ParserRuleSchema.id, { onDelete: 'cascade' }).notNull(),
});
```

#### Routes
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/parser-rules/templates` | ✅ | List all production templates |
| GET | `/parser-rules/templates/:id` | ✅ | Get template with all its rules |
| POST | `/parser-rules/templates/:id/audit` | ✅ | Trigger AI audit on a candidate template |
| PATCH | `/parser-rules/templates/:id/promote` | ✅ | Manually promote an audited template to production |

#### Service Notes

**`ParserRuleService`** must expose these internal methods (used by `IngestionService`, not via HTTP):

```typescript
// Try to parse raw email text using production templates for a given bank
applyTemplate(bankId: number, emailBody: string, emailSubject: string): Promise<ParsedTransaction | null>

// Generate a new template + rules from a raw email using AI
generateTemplate(bankId: number, emailBody: string, emailSubject: string): Promise<ParserTemplate>

// Send a candidate template to AI for audit. Updates status to 'audited' or 'failed_audit'.
auditTemplate(templateId: number): Promise<AuditResult>

// Record a successful match — increments matchCount, recalculates confidenceScore
recordMatch(templateId: number): Promise<void>

// Record a failed match — increments failCount, recalculates confidenceScore.
// If confidenceScore drops below REGEX_REAUDIT_THRESHOLD, mark for re-audit.
recordFailure(templateId: number): Promise<void>
```

**Confidence score formula:**
```
confidenceScore = matchCount / (matchCount + failCount * 2)
```
Weight failures more heavily — two failures cancel one success.

**AI Prompt for `generateTemplate`:**

The prompt must instruct GPT-4o to:
1. Analyse the raw email body and subject
2. Identify what type of transaction it is (debit/credit, what fields are present)
3. Return a JSON object with one regex per field (`amount`, `currency`, `merchant`, `transaction_type`, `date`, `balance`, `reference`) — only fields that are actually present in the email
4. Each regex must include a named or numbered capture group for the extracted value
5. Return JSON only, no explanation

**AI Prompt for `auditTemplate`:**

The prompt must instruct GPT-4o to:
1. Review each regex in the template
2. For each regex: assess whether it is correct, robust to whitespace/formatting variation, and not over-broad
3. Flag any regex likely to match false positives or break on minor template changes
4. Return a JSON audit result: `{ passed: boolean, notes: string, field_results: { field: string, passed: boolean, concern?: string }[] }`
5. Return JSON only

---

### Module 6: `ingestion`

Orchestrates Gmail polling, email classification, and transaction creation. This module has no controller (no HTTP routes). It runs entirely as a background service started at app bootstrap.

#### Drizzle Schema (`ingestion.schema.ts`)
```typescript
// Tracks every raw email we have processed to avoid duplicate parsing
export const ProcessedEmailSchema = pgTable('processed_emails', {
  id: serial('id').primaryKey(),
  emailConnectionId: integer('email_connection_id').references(() => EmailConnectionSchema.id, { onDelete: 'cascade' }).notNull(),
  gmailMessageId: text('gmail_message_id').notNull(),
  processedAt: timestamp('processed_at').defaultNow().notNull(),
  outcome: text('outcome').notNull(), // 'parsed' | 'non_transaction' | 'failed'
  transactionId: integer('transaction_id'), // nullable — set if outcome is 'parsed'
});
```

#### Service: `IngestionService`

Responsible for the full ingestion pipeline:

```typescript
// Called by cron job every GMAIL_POLL_INTERVAL_MINUTES
pollAllConnections(): Promise<void>

// Process a single email connection
pollConnection(connectionId: number): Promise<void>

// Classify and parse a single Gmail message
processMessage(connectionId: number, messageId: string, emailBody: string, emailSubject: string, fromAddress: string): Promise<void>
```

**Pipeline per message:**

```
1. Check ProcessedEmail — skip if already processed (idempotent)
2. Identify bank from fromAddress → match against bank.knownSenderEmails
   - If no match: log as 'non_transaction', mark processed, return
3. Classify email: is this a transaction email or a non-transactional bank email?
   - Use a lightweight regex check first: does body contain amount-like patterns?
   - If clearly non-transactional (promotions, OTPs, statements): mark as 'non_transaction', return
4. Attempt Tier 3 (regex): call ParserRuleService.applyTemplate(bankId, body, subject)
   - If result returned and confidence >= REGEX_PRODUCTION_THRESHOLD:
     → Create transaction with status 'verified'
     → Record match on template
     → Mark processed as 'parsed'
     → return
5. Tier 1 (AI parsing): call ParserRuleService.generateTemplate(bankId, body, subject)
   - Create new candidate template
   - Parse the email using the AI-generated regexes immediately (for this transaction)
   - Create transaction with status 'unverified'
   - Asynchronously trigger: ParserRuleService.auditTemplate(newTemplateId)
     → if audit passes: promote to 'audited', then auto-promote to 'production'
     → if audit fails: mark 'failed_audit', log for manual review
   - Mark processed as 'parsed'
6. On any unhandled error: mark processed as 'failed', log with context
```

#### Cron Setup

Register the cron job in `src/init-dependencies.ts` after all modules are wired:

```typescript
import cron from 'node-cron';
// Run every GMAIL_POLL_INTERVAL_MINUTES
cron.schedule(`*/${CONSTANTS.GMAIL_POLL_INTERVAL_MINUTES} * * * *`, async () => {
  const ingestionService = container.resolve(IngestionService);
  await ingestionService.pollAllConnections();
});
```

---

### Module 7: `transaction`

Stores all parsed transactions. The source of truth for all financial data.

#### Enums (`transaction.enum.ts`)
```typescript
export enum TransactionTypeEnum {
  DEBIT = 'debit',
  CREDIT = 'credit',
}

export enum TransactionStatusEnum {
  VERIFIED = 'verified',         // Parsed by a production regex with high confidence
  UNVERIFIED = 'unverified',     // Parsed by AI, pending user review
  REVIEW = 'review',             // Flagged for manual review (low confidence or user dispute)
  CORRECTED = 'corrected',       // User has manually corrected this transaction
}

export enum CategoryEnum {
  FOOD = 'food',
  TRANSIT = 'transit',
  UTILITY = 'utility',
  SUBSCRIPTIONS = 'subs',
  TRANSFER = 'transfer',
  ENTERTAINMENT = 'fun',
  HEALTH = 'health',
  OTHER = 'other',
}
```

#### Drizzle Schema (`transaction.schema.ts`)
```typescript
export const TransactionSchema = pgTable('transactions', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => UserSchema.id, { onDelete: 'cascade' }).notNull(),
  emailConnectionId: integer('email_connection_id').references(() => EmailConnectionSchema.id, { onDelete: 'set null' }),
  bankId: integer('bank_id').references(() => BankSchema.id, { onDelete: 'set null' }),
  parserTemplateId: integer('parser_template_id'), // which template parsed this (nullable)
  gmailMessageId: text('gmail_message_id'),         // for deduplication reference
  merchant: text('merchant').notNull(),
  category: text('category').notNull(),
  transactionType: text('transaction_type').notNull(),
  amount: real('amount').notNull(),                 // signed: negative = debit, positive = credit
  currency: text('currency').notNull(),
  refAmount: real('ref_amount').notNull(),          // amount converted to user's ref currency at time of parsing
  refCurrency: text('ref_currency').notNull(),
  exchangeRateUsed: real('exchange_rate_used'),     // rate at parse time, for record
  transactionDate: timestamp('transaction_date').notNull(),
  status: text('status').default('unverified').notNull(),
  originalMerchant: text('original_merchant'),      // preserved before any user correction
  originalCategory: text('original_category'),
  reference: text('reference'),                     // bank reference number if available
  balance: real('balance'),                         // account balance after transaction if available
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
```

#### DTOs (`transaction.dto.ts`)
```typescript
// PATCH /transactions/:id — user correction
export const CorrectTransactionSchema = z.object({
  merchant: z.string().min(1).optional(),
  category: z.nativeEnum(CategoryEnum).optional(),
  transaction_type: z.nativeEnum(TransactionTypeEnum).optional(),
  amount: z.number().optional(),
});

// GET /transactions query filters
export const TransactionQuerySchema = z.object({
  page: z.coerce.number().default(1),
  limit: z.coerce.number().default(20),
  category: z.nativeEnum(CategoryEnum).optional(),
  currency: z.string().optional(),
  bank_id: z.coerce.number().optional(),
  status: z.nativeEnum(TransactionStatusEnum).optional(),
  date_from: z.string().datetime().optional(),
  date_to: z.string().datetime().optional(),
  search: z.string().optional(), // merchant name search
});

// GET /transactions/summary response
export const TransactionSummarySchema = z.object({
  period_start: z.string(),
  period_end: z.string(),
  total_spend: z.number(),
  total_income: z.number(),
  net: z.number(),
  ref_currency: z.string(),
  by_category: z.array(z.object({
    category: z.string(),
    total: z.number(),
    count: z.number(),
    percentage: z.number(),
  })),
  by_currency: z.array(z.object({
    currency: z.string(),
    spend: z.number(),
    income: z.number(),
    net: z.number(),
  })),
  vs_last_period_pct: z.number().nullable(),
});
```

#### Routes
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/transactions` | ✅ | Paginated, filterable transaction list |
| GET | `/transactions/summary` | ✅ | Monthly summary — totals by category and currency. Accepts `?year=&month=` params |
| GET | `/transactions/:id` | ✅ | Single transaction detail |
| PATCH | `/transactions/:id` | ✅ | Correct merchant, category, or amount. Sets status to `corrected`. Also triggers `ParserRuleService.recordFailure()` on the originating template — user correction is the strongest negative signal |
| GET | `/transactions/unverified` | ✅ | List of transactions needing user review (status = `unverified` or `review`) |

#### Data Retention
In `TransactionService`, expose a `pruneExpiredTransactions()` method that deletes transactions older than `user.dataRetentionMonths`. Schedule this daily via cron at 2:00 AM.

---

### Module 8: `exchange-rate`

Fetches and caches FX rates. All conversions use rates stored here — never call the rates API inline during transaction processing.

#### Drizzle Schema (`exchange-rate.schema.ts`)
```typescript
export const ExchangeRateSchema = pgTable('exchange_rates', {
  id: serial('id').primaryKey(),
  baseCurrency: text('base_currency').notNull(),     // always 'USD' (OpenExchangeRates base)
  targetCurrency: text('target_currency').notNull(),
  rate: real('rate').notNull(),
  fetchedAt: timestamp('fetched_at').defaultNow().notNull(),
});
// Add a unique index on (base_currency, target_currency) to allow upsert
```

#### Routes
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/exchange-rates` | ✅ | Return latest rates for all tracked currencies, relative to user's `ref_currency` |

#### Service Notes
- `ExchangeRateService.fetchAndRefresh()` calls Open Exchange Rates `https://openexchangerates.org/api/latest.json?app_id=...&base=USD` and upserts all rates.
- Schedule a refresh every 6 hours via cron.
- `ExchangeRateService.convert(amount, fromCurrency, toCurrency)` reads from the DB — never calls the external API inline.
- All transaction `refAmount` values are computed at ingestion time using the rate at that moment. Rates are not retroactively updated on stored transactions.

---

### Module 9: `budget`

User-defined spending budgets per category.

#### Enums (`budget.enum.ts`)
```typescript
export enum BudgetPeriodEnum {
  MONTHLY = 'monthly',
  WEEKLY = 'weekly',
}
```

#### Drizzle Schema (`budget.schema.ts`)
```typescript
export const BudgetSchema = pgTable('budgets', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => UserSchema.id, { onDelete: 'cascade' }).notNull(),
  category: text('category').notNull(),
  limitAmount: real('limit_amount').notNull(),
  currency: text('currency').notNull(),            // budget is denominated in ref currency
  periodType: text('period_type').default('monthly').notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  isSuggestedByAi: boolean('is_suggested_by_ai').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
```

#### DTOs (`budget.dto.ts`)
```typescript
export const CreateBudgetSchema = z.object({
  category: z.nativeEnum(CategoryEnum),
  limit_amount: z.number().positive(),
  currency: z.string(),
  period_type: z.nativeEnum(BudgetPeriodEnum).default('monthly'),
});

export const BudgetWithProgressSchema = z.object({
  id: z.number(),
  category: z.string(),
  limit_amount: z.number(),
  currency: z.string(),
  period_type: z.string(),
  spent: z.number(),             // computed from transactions for current period
  remaining: z.number(),
  percentage: z.number(),
  status: z.enum(['healthy', 'warning', 'over']),
  days_remaining: z.number(),
});
```

#### Routes
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/budgets` | ✅ | List active budgets with computed spend progress for current period |
| POST | `/budgets` | ✅ | Create a new budget |
| PATCH | `/budgets/:id` | ✅ | Update limit or period |
| DELETE | `/budgets/:id` | ✅ | Deactivate budget |
| GET | `/budgets/suggestions` | ✅ | AI-generated budget suggestions based on last 3 months of transaction data |

#### Service Notes for `/budgets/suggestions`
- Query the last 3 months of spending per category for the user.
- For each category that has no active budget: compute the average monthly spend and suggest a limit 10% lower (as a gentle nudge).
- Pass the spending data and user goal context to GPT-4o for phrasing — the suggestion copy ("Based on your last 3 months...") should be generated by AI to match the advisor tone.
- Cache suggestions for 24 hours — do not call AI on every request.

---

### Module 10: `goal`

User's stated financial goal with optional target amount and progress tracking.

#### Drizzle Schema (`goal.schema.ts`)
```typescript
export const GoalSchema = pgTable('goals', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => UserSchema.id, { onDelete: 'cascade' }).notNull(),
  name: text('name').notNull(),
  type: text('type').notNull(),                    // GoalTypeEnum value
  targetAmount: real('target_amount'),
  savedAmount: real('saved_amount').default(0).notNull(),
  currency: text('currency').notNull(),
  targetDate: timestamp('target_date'),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
```

#### Routes
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/goals` | ✅ | List user goals with progress |
| POST | `/goals` | ✅ | Create a goal |
| PATCH | `/goals/:id` | ✅ | Update goal details or saved amount |
| DELETE | `/goals/:id` | ✅ | Delete goal |

---

### Module 11: `insight`

AI-generated advisor insights. Insights are generated proactively by a background job and stored for retrieval. They are never generated on-demand (to keep response times fast and AI costs predictable).

#### Enums (`insight.enum.ts`)
```typescript
export enum InsightTypeEnum {
  SPENDING_PATTERN = 'spending_pattern',
  BUDGET_WARNING = 'budget_warning',
  GOAL_PROGRESS = 'goal_progress',
  FX_IMPACT = 'fx_impact',
  SUBSCRIPTION_ALERT = 'subscription_alert',
  POSITIVE_REINFORCEMENT = 'positive_reinforcement',
}
```

#### Drizzle Schema (`insight.schema.ts`)
```typescript
export const InsightSchema = pgTable('insights', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => UserSchema.id, { onDelete: 'cascade' }).notNull(),
  type: text('type').notNull(),
  message: text('message').notNull(),              // the human-readable advisor message
  contextData: json('context_data'),               // structured data that backs the insight
  isRead: boolean('is_read').default(false).notNull(),
  expiresAt: timestamp('expires_at'),              // insights auto-expire after 7 days
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
```

#### Routes
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/insights` | ✅ | List active (non-expired), ordered by recency. Supports `?unread_only=true` |
| PATCH | `/insights/:id/read` | ✅ | Mark insight as read |

#### Service Notes
`InsightGenerationService.generateForUser(userId)` — run nightly via cron:
1. Fetch last 30 days of transactions for the user.
2. Fetch active budgets and current spend.
3. Fetch goals.
4. Fetch FX rates and compare vs 90 days ago.
5. Build a structured context object and pass to GPT-4o with the user's `advisorTone` and `goalType`.
6. GPT-4o returns an array of insight objects (JSON). Store each as an `Insight` record.
7. Delete insights older than 7 days for the user.
8. Never create duplicate insights — check for same `type` within 48 hours before inserting.

**GPT-4o system prompt for insight generation** (include in the service):
> You are Iris, a warm and non-judgmental personal financial advisor. You observe patterns in a user's spending data and surface one to three insights that are specific, actionable, and forward-looking. You never shame. You always frame observations as opportunities. The user's goal is {goalType} and their preferred tone is {advisorTone}. Return a JSON array of insight objects: `[{ type, message, context_data }]`. Message must be 1–2 sentences. Return JSON only.

---

## Authentication Middleware

In `authentication.middleware.ts`, add these to `authPrefixes`:

```typescript
const authPrefixes = [
  '/api/users',
  '/api/email-connections',
  '/api/banks',
  '/api/transactions',
  '/api/exchange-rates',
  '/api/budgets',
  '/api/goals',
  '/api/insights',
  '/api/parser-rules',
];
```

`/api/auth` is excluded (login routes need no auth).

---

## Router Tokens

Add to `src/common/constants/router.tokens.ts`:

```typescript
export const ROUTER_TOKENS = {
  AUTH: Symbol.for('AuthRouter'),
  USER: Symbol.for('UserRouter'),
  EMAIL_CONNECTION: Symbol.for('EmailConnectionRouter'),
  BANK: Symbol.for('BankRouter'),
  PARSER_RULE: Symbol.for('ParserRuleRouter'),
  TRANSACTION: Symbol.for('TransactionRouter'),
  EXCHANGE_RATE: Symbol.for('ExchangeRateRouter'),
  BUDGET: Symbol.for('BudgetRouter'),
  GOAL: Symbol.for('GoalRouter'),
  INSIGHT: Symbol.for('InsightRouter'),
};
```

---

## `init-dependencies.ts` — Registration Order

```typescript
await registerAuthDependencies();
await registerUserDependencies();
await registerEmailConnectionDependencies();
await registerBankDependencies();
await registerParserRuleDependencies();
await registerIngestionDependencies();    // no controller — starts cron internally
await registerTransactionDependencies();
await registerExchangeRateDependencies(); // starts FX refresh cron internally
await registerBudgetDependencies();
await registerGoalDependencies();
await registerInsightDependencies();      // starts nightly insight cron internally
```

---

## Data Privacy Requirements

- **Never log raw email body content.** Log only metadata: sender, subject, message ID, outcome.
- **Never store raw email body.** Only the structured transaction record is persisted. Once parsed, the email content is discarded.
- **OAuth tokens at rest must always be encrypted** using `TokenEncryptionService`. The plaintext token must never touch the database.
- **The `ProcessedEmail` table stores only the Gmail message ID** (a unique string like `18f2b3c4d5e6`) — not any email content.
- **On user DELETE**, cascade-delete all records including `processed_emails`, `transactions`, `budgets`, `goals`, `insights`, and `email_connections`. Also revoke Gmail OAuth tokens.
- **Data retention**: the daily pruning cron in `TransactionService` must enforce `user.dataRetentionMonths` per user.

---

## Swagger

Every controller method must have a complete `@swagger` JSDoc block. Common response schemas (`401`, `404`, `400`, `500`) must use `$ref` to the shared components in `swagger.yaml`. Document all query parameters for `GET /transactions` and `GET /transactions/summary`.

---

## Migration Checklist

After all schemas are written, run:

```bash
npm run db:generate
npm run db:migrate
```

Then seed the `banks` table with the entries listed under Module 4.
