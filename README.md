# FinTrack Backend

REST API for the FinTrack personal finance app. Parses bank alert emails via Gmail, categorises transactions with a regex-first / AI-fallback pipeline, and surfaces spending insights, budgets, and goals.

**Stack:** Express 5 · TypeScript · PostgreSQL · Drizzle ORM · tsyringe DI · OpenAI GPT-4o

---

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Start the database
docker compose up -d

# 3. Copy and fill in environment variables
cp .env.example .env

# 4. Push schema to the database
npm run db:push

# 5. Seed reference data
npx ts-node -r tsconfig-paths/register scripts/seed-banks.ts
npm run seed:admin

# 6. Start the dev server
npm run dev
```

API runs on `http://localhost:3000`.  
Swagger UI: `http://localhost:3000/api-docs`  
OpenAPI JSON (Postman/Insomnia import): `http://localhost:3000/api-docs/openapi.json`

---

## Environment variables

Create a `.env` file in the project root. All variables are required unless a default is shown.

```env
# Server
PORT=3000
FRONTEND_ORIGIN=http://localhost:3001

# Database
DATABASE_URL=postgresql://postgres:password@localhost:5432/fintrack

# User auth (JWT)
JWT_SECRET=<strong-random-secret>
JWT_EXPIRES_IN=15m                        # default: 15m

# Admin auth (separate secret — must differ from JWT_SECRET)
ADMIN_JWT_SECRET=<different-strong-secret>
ADMIN_JWT_EXPIRES_IN=4h                   # default: 4h

# Google OAuth + Gmail
GOOGLE_CLIENT_ID=<from-google-console>
GOOGLE_CLIENT_SECRET=<from-google-console>
GOOGLE_REDIRECT_URI=http://localhost:3000/api/email-connections/google/callback

# Apple Sign-In
APPLE_CLIENT_ID=<apple-service-id>
APPLE_TEAM_ID=<apple-team-id>
APPLE_KEY_ID=<apple-key-id>
APPLE_PRIVATE_KEY=<contents-of-AuthKey.p8>

# OpenAI
OPENAI_API_KEY=<your-key>
OPENAI_MODEL=gpt-4o                       # default: gpt-4o

# AI cost tracking (USD per 1 000 tokens — update when model pricing changes)
OPENAI_COST_PER_1K_INPUT_TOKENS=0.0025   # default: 0.0025
OPENAI_COST_PER_1K_OUTPUT_TOKENS=0.010   # default: 0.010

# Exchange rates (openexchangerates.org free tier — 3 fetches/day)
OPEN_EXCHANGE_RATES_APP_ID=<your-app-id>

# Gmail token encryption (32-byte hex key)
TOKEN_ENCRYPTION_KEY=<32-byte-hex>

# Gmail polling interval
GMAIL_POLL_INTERVAL_MINUTES=15            # default: 15

# Regex engine thresholds
REGEX_PRODUCTION_THRESHOLD=0.85           # default: 0.85
REGEX_REAUDIT_THRESHOLD=0.60             # default: 0.60
```

---

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Dev server with hot-reload (nodemon + ts-node) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled output |
| `npm run db:generate` | Generate Drizzle migration files |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:push` | Push schema directly (dev only — skips migration files) |
| `npm run db:studio` | Open Drizzle Studio |
| `npm run seed:admin` | Insert default admin user (`admin@fintrack.app` / `ChangeMe123!`) |
| `npm run lint` | ESLint |
| `npm run lint:fix` | ESLint with auto-fix |
| `npm run format` | Prettier |

---

## Project structure

```
src/
├── common/
│   ├── configuration/    # CONSTANTS — single source for all env vars
│   ├── decorators/       # @Controller, @Get, @Post, @Patch, @Delete
│   ├── exception/        # Typed HTTP exceptions
│   ├── lib/
│   │   ├── database/     # Drizzle client + migrate()
│   │   ├── logger/       # Winston logger
│   │   └── swagger/      # Swagger setup + swagger.yaml schemas
│   ├── middleware/        # Auth, error handlers, rate limiter
│   └── utils/            # cost-calculator, route-registry
├── middleware/
│   ├── authentication.middleware.ts   # JWT — applied to user routes
│   └── admin.middleware.ts            # Admin JWT — applied to /admin/*
├── modules/
│   ├── admin/            # Analytics dashboard + admin auth
│   ├── auth/             # Google / Apple sign-in, token refresh
│   ├── bank/             # Bank registry
│   ├── budget/           # Budget CRUD + AI suggestions
│   ├── email-connection/ # Gmail OAuth connection management
│   ├── exchange-rate/    # Currency rates (refreshed 3×/day)
│   ├── goal/             # Financial goals
│   ├── ingestion/        # Gmail polling + email parsing pipeline
│   ├── insight/          # AI-generated spending insights
│   ├── parser-rule/      # Regex template engine + AI audit
│   ├── transaction/      # Transaction CRUD + corrections
│   └── user/             # User profile management
├── app.ts                # Express app wiring
├── init-dependencies.ts  # tsyringe container bootstrap
└── index.ts              # Entry point
scripts/
├── seed-banks.ts         # Seed supported banks
└── seed-admin.ts         # Seed default admin user
```

---

## Architecture

### Dependency injection

All services, repositories, and controllers are registered with [tsyringe](https://github.com/microsoft/tsyringe). The full registration order is centralised in `init-dependencies.ts` — all tokens must be registered before any controllers are resolved to avoid circular dependency errors.

### Request handling

Controllers extend `BaseController` and use method decorators (`@Get`, `@Post`, etc.). Each handler receives `req` and returns a plain object; `BaseController` serialises it as JSON. Zod schemas can be passed to the decorator for automatic request validation.

### Email parsing pipeline

1. Gmail is polled every `GMAIL_POLL_INTERVAL_MINUTES` minutes for each connected account.
2. Emails are matched against production regex templates for the sender's bank (**regex-first**).
3. If no template matches, GPT-4o parses the email and generates a new candidate template (**AI-fallback**).
4. AI-generated templates are automatically audited by GPT-4o and promoted to production when confidence ≥ `REGEX_PRODUCTION_THRESHOLD`.
5. Every OpenAI call is logged to `ai_usage_logs` for cost tracking.

### Scheduled jobs

| Schedule | Job |
|---|---|
| Every `GMAIL_POLL_INTERVAL_MINUTES` minutes | Poll Gmail for new bank emails |
| Daily 2:00 AM | Prune expired transactions |
| Daily 2:30 AM | Generate AI insights for all users |
| Daily 3:00 AM | Save admin analytics snapshot |
| Every 8 hours | Refresh exchange rates |

---

## API overview

All user endpoints are prefixed `/api` and require `Authorization: Bearer <access_token>` unless noted.

| Module | Base path | Notes |
|---|---|---|
| Auth | `/api/auth` | Public — Google / Apple OAuth |
| Users | `/api/users` | Profile, onboarding |
| Email connections | `/api/email-connections` | Gmail OAuth flow |
| Banks | `/api/banks` | Read-only bank registry |
| Transactions | `/api/transactions` | CRUD + corrections |
| Parser rules | `/api/parser-rules` | Regex template management |
| Exchange rates | `/api/exchange-rates` | Latest FX rates |
| Budgets | `/api/budgets` | Budget CRUD + AI suggestions |
| Goals | `/api/goals` | Financial goals |
| Insights | `/api/insights` | AI-generated spending insights |
| **Admin** | `/api/admin` | Requires admin JWT (see below) |

### Admin API

The admin module is at `/api/admin`. All routes except login require `Authorization: Bearer <admin_token>`.

```
POST   /api/admin/auth/login            # Get admin JWT
POST   /api/admin/auth/logout           # Client-side discard
GET    /api/admin/auth/me               # Logged-in admin info
PATCH  /api/admin/auth/me/password      # Change password

GET    /api/admin/overview              # System-wide snapshot
GET    /api/admin/regex/health          # Regex engine health by bank
GET    /api/admin/regex/templates       # Paginated template list
GET    /api/admin/regex/audit-queue     # Templates awaiting audit
GET    /api/admin/regex/gaps            # Banks with no production templates
GET    /api/admin/regex/corrections     # Templates with high correction rates
GET    /api/admin/ingestion/health      # Pipeline health + stale connections
GET    /api/admin/ingestion/timeline    # Daily ingestion volumes
GET    /api/admin/transactions/volume   # Volume by bank / currency / category
GET    /api/admin/users/stats           # Growth, retention, onboarding funnel
GET    /api/admin/users/:id/regex-stat  # Per-user regex vs AI breakdown
GET    /api/admin/ai/usage              # Token usage and cost breakdown
```

Default admin credentials (change immediately after first login):

```
Email:    admin@fintrack.app
Password: ChangeMe123!
```

---

## Database

Schema is defined in `src/modules/**/*.schema.ts` and picked up automatically by `drizzle.config.ts`.

**First-time setup:**

```bash
docker compose up -d
npm run db:push          # create all tables
npx ts-node -r tsconfig-paths/register scripts/seed-banks.ts
npm run seed:admin
```

**Subsequent schema changes:**

```bash
npm run db:generate      # creates a migration file in drizzle/
npm run db:migrate       # applies it
```

Use `npm run db:studio` to browse data at `https://local.drizzle.studio`.
