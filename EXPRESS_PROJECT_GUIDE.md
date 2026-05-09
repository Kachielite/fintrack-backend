# Express TypeScript Project Structure Guide

This document is a reference guide for AI agents and developers spinning up a new Express + TypeScript backend project. Follow every convention here exactly — it reflects the intended architecture and patterns for all projects in this family.

---

## Technology Stack

| Concern | Library |
|---|---|
| Runtime | Node.js + TypeScript |
| Framework | Express 5 |
| Dependency Injection | tsyringe |
| ORM | Drizzle ORM |
| Database | PostgreSQL (via `pg`) |
| Validation | Zod |
| Auth | JWT (jsonwebtoken) |
| Password hashing | bcrypt |
| Email | Nodemailer |
| Logging | Winston |
| Security | Helmet + custom traffic filter |
| Docs | Swagger (swagger-jsdoc + swagger-ui-express) |
| Linting/Formatting | ESLint + Prettier + Husky + lint-staged |

---

## Directory Structure

```
project-root/
├── drizzle/                  # Auto-generated SQL migration files
│   └── meta/                 # Drizzle migration metadata
├── logs/                     # Winston log output files
│   ├── combined.log
│   └── error.log
├── scripts/                  # One-off utility scripts (e.g. gen-swagger.js)
├── src/
│   ├── index.ts              # Entry point — bootstraps the app
│   ├── app.ts                # App class — wires middleware, routes, error handling
│   ├── init-dependencies.ts  # DI container configuration and module registration
│   ├── common/
│   │   ├── configuration/
│   │   │   └── constants.ts          # All env vars loaded via dotenv, exported as CONSTANTS
│   │   ├── constants/
│   │   │   ├── app.tokens.ts         # DI tokens for app-level singletons
│   │   │   └── router.tokens.ts      # DI tokens for each module's Express Router
│   │   ├── decorators/
│   │   │   └── controller.decorator.ts  # @Controller, @Get, @Post, @Put, @Delete, BaseController
│   │   ├── exception/
│   │   │   ├── http-error.ts         # Base HttpError class + ErrorResponseDTO
│   │   │   └── index.ts              # Named exception classes (BadRequest, NotFound, etc.)
│   │   ├── lib/
│   │   │   ├── database/
│   │   │   │   ├── index.ts          # Database class — Drizzle client + migrate()
│   │   │   │   └── drizzle.config.ts # Drizzle Kit configuration
│   │   │   ├── logger.ts             # Winston logger singleton
│   │   │   └── swagger/
│   │   │       ├── index.ts          # setupSwagger() helper
│   │   │       └── swagger.yaml      # Optional base Swagger definition
│   │   ├── providers/
│   │   │   └── app-services.provider.ts  # AppServicesProvider — bundles shared middleware/services
│   │   ├── types/
│   │   │   └── interface.ts          # Shared interfaces: IAppService, IGeneralResponse, IPagination, IAuthenticatedRequest
│   │   └── utils/
│   │       ├── otp-generator.ts
│   │       ├── password-encoder.ts
│   │       ├── route-listing.ts      # printRoutes() — dev utility
│   │       └── route-registry.ts     # registerMount() / getMounts() — auto-route wiring
│   ├── middleware/
│   │   ├── authentication.middleware.ts   # JWT verification, attaches req.user
│   │   ├── global-exception.middleware.ts # 404 + global error handler
│   │   ├── request-validation.middleware.ts # Zod-based body/query/params validation
│   │   └── traffic-filter.middleware.ts   # Rate limiter + probe blocker
│   └── modules/
│       └── <feature>/               # One folder per domain feature
│           ├── <feature>.controller.ts
│           ├── <feature>.service.ts
│           ├── <feature>.repository.ts
│           ├── <feature>.dto.ts
│           ├── <feature>.schema.ts
│           ├── <feature>.interface.ts
│           ├── <feature>.enum.ts
│           └── <feature>.dependencies.ts
├── .env                      # Local environment variables (never commit)
├── .env.production
├── .prettierrc
├── .prettierignore
├── docker-compose.yml
├── Dockerfile
├── drizzle.config.ts         # Re-exports from src/common/lib/database/drizzle.config.ts
├── eslint.config.mjs
├── package.json
└── tsconfig.json
```

---

## Bootstrap Flow

Follow this exact sequence:

```
src/index.ts
  └─ configureContainer()                  [init-dependencies.ts]
       ├─ container.registerSingleton(Database)
       ├─ await db.migrate()               — run pending SQL migrations
       ├─ container.registerInstance(EXPRESS_APP, express())
       ├─ registerXxxDependencies()        — one call per module (see below)
       └─ container.registerSingleton(App)
  └─ container.resolve(App)               [app.ts]
       ├─ initiateMiddleware()
       ├─ initiateRoutes()
       └─ initiateErrorHandler()
  └─ app.start(CONSTANTS.PORT)
```

---

## Middleware Stack (Order Matters)

Registered in `app.ts → initiateMiddleware()` in this exact order:

1. `express.json()` + `express.urlencoded({ extended: true })`
2. `helmet()` — security headers
3. `cors({ origin: CONSTANTS.FRONTEND_ORIGIN, credentials: true })`
4. `trafficFilter` — rate limiting + probe path blocking
5. `authenticationMiddleware.authenticate` — JWT verification

Error handlers are registered last via `initiateErrorHandler()`:
1. `resourceNotFoundHandler` — 404 fallback
2. `allExceptionHandler` — catches all `HttpError` instances (4 arguments = Express error middleware)

---

## Module Structure

Every domain feature follows this identical file structure:

### `<feature>.schema.ts` — Drizzle table definition

```typescript
import { integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { UserSchema } from '@/modules/user/user.schema';

export const FeatureSchema = pgTable('features', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => UserSchema.id, { onDelete: 'cascade' })
    .notNull(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
```

### `<feature>.enum.ts` — TypeScript enums for the domain

```typescript
export enum FeatureStatusEnum {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}
```

### `<feature>.interface.ts` — Internal domain interfaces (camelCase)

```typescript
import { IPaginationParams } from '@/common/types/interface';
import { FeatureStatusEnum } from './feature.enum';

export interface IFeature {
  id: number;
  userId: number;
  name: string;
  status: FeatureStatusEnum;
  createdAt: Date;
  updatedAt: Date;
}

export interface ICreateFeature {
  userId: number;
  name: string;
  status?: FeatureStatusEnum;
}

export interface IFeatureById {
  userId: number;
  featureId: number;
}
```

### `<feature>.dto.ts` — Zod schemas for request/response shapes (snake_case for API surface)

```typescript
import { z } from 'zod';
import { FeatureStatusEnum } from './feature.enum';

export const CreateFeatureSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  status: z.nativeEnum(FeatureStatusEnum).optional(),
});
export type CreateFeatureDTO = z.infer<typeof CreateFeatureSchema>;

export const UpdateFeatureSchema = z.object({
  name: z.string().min(1).optional(),
  status: z.nativeEnum(FeatureStatusEnum).optional(),
});
export type UpdateFeatureDTO = z.infer<typeof UpdateFeatureSchema>;

export const FeatureResponseSchema = z.object({
  id: z.number(),
  user_id: z.number(),
  name: z.string(),
  status: z.nativeEnum(FeatureStatusEnum),
  created_at: z.date(),
  updated_at: z.date(),
});
export type FeatureResponseDTO = z.infer<typeof FeatureResponseSchema>;
```

> **Convention:** internal interfaces use camelCase; API DTOs (request/response) use snake_case.

### `<feature>.repository.ts` — Data access layer

- Defines an `IFeatureRepository` interface at the top.
- Implements it in a class named `FeatureRepositoryImpl` decorated with `@injectable()`.
- Injects `Database` directly via `@inject(Database)`.
- Never throws domain-level errors — let the service layer handle those.

```typescript
import { inject, injectable } from 'tsyringe';
import Database from '@/common/lib/database';
import { IFeature, ICreateFeature, IFeatureById } from './feature.interface';
import { FeatureSchema } from './feature.schema';
import { eq, and } from 'drizzle-orm';

export interface IFeatureRepository {
  createFeature(data: ICreateFeature): Promise<IFeature>;
  getFeatureById(data: IFeatureById): Promise<IFeature | null>;
  deleteFeature(data: IFeatureById): Promise<void>;
}

@injectable()
class FeatureRepositoryImpl implements IFeatureRepository {
  constructor(@inject(Database) private db: Database) {}

  async createFeature(data: ICreateFeature): Promise<IFeature> {
    const [row] = await this.db.client
      .insert(FeatureSchema)
      .values({ userId: data.userId, name: data.name })
      .returning();
    return row as IFeature;
  }

  async getFeatureById({ userId, featureId }: IFeatureById): Promise<IFeature | null> {
    const rows = await this.db.client
      .select()
      .from(FeatureSchema)
      .where(and(eq(FeatureSchema.id, featureId), eq(FeatureSchema.userId, userId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async deleteFeature({ userId, featureId }: IFeatureById): Promise<void> {
    await this.db.client
      .delete(FeatureSchema)
      .where(and(eq(FeatureSchema.id, featureId), eq(FeatureSchema.userId, userId)));
  }
}

export default FeatureRepositoryImpl;
```

### `<feature>.service.ts` — Business logic layer

- Defines an `IFeatureService` interface.
- Class `FeatureService` is `@injectable()` and injects the repository by **string token** `'IFeatureRepository'`.
- Always catches errors, logs them, and re-throws typed `HttpError` subclasses.
- Maps raw DB results to DTOs via a private `mapToDTO()` method.

```typescript
import { inject, injectable } from 'tsyringe';
import { IFeatureRepository } from './feature.repository';
import { IFeatureById } from './feature.interface';
import { FeatureResponseDTO, CreateFeatureDTO } from './feature.dto';
import { IGeneralResponse } from '@/common/types/interface';
import { InternalServerException, ResourceNotFoundException } from '@/common/exception';
import logger from '@/common/lib/logger';

export interface IFeatureService {
  createFeature(userId: number, data: CreateFeatureDTO): Promise<FeatureResponseDTO>;
  deleteFeature(data: IFeatureById): Promise<IGeneralResponse<null>>;
}

@injectable()
class FeatureService implements IFeatureService {
  constructor(
    @inject('IFeatureRepository') private featureRepository: IFeatureRepository,
  ) {}

  async createFeature(userId: number, data: CreateFeatureDTO): Promise<FeatureResponseDTO> {
    try {
      logger.info(`Creating feature for userId: ${userId}`);
      const feature = await this.featureRepository.createFeature({ userId, name: data.name });
      return this.mapToDTO(feature);
    } catch (error) {
      logger.error(`Error creating feature for userId: ${userId} - ${error}`);
      throw new InternalServerException('An error occurred while creating the feature.');
    }
  }

  async deleteFeature(data: IFeatureById): Promise<IGeneralResponse<null>> {
    try {
      const existing = await this.featureRepository.getFeatureById(data);
      if (!existing) throw new ResourceNotFoundException('Feature not found.');
      await this.featureRepository.deleteFeature(data);
      return { success: true, message: 'Feature deleted successfully', data: null };
    } catch (error) {
      if (error instanceof ResourceNotFoundException) throw error;
      logger.error(`Error deleting feature - ${error}`);
      throw new InternalServerException('An error occurred while deleting the feature.');
    }
  }

  private mapToDTO(feature: any): FeatureResponseDTO {
    return {
      id: feature.id,
      user_id: feature.userId,
      name: feature.name,
      status: feature.status,
      created_at: feature.createdAt,
      updated_at: feature.updatedAt,
    };
  }
}

export default FeatureService;
```

### `<feature>.controller.ts` — HTTP layer

- Decorated with `@injectable()` and `@Controller('/route-prefix')`.
- Extends `BaseController`.
- Constructor injects the module's Router via `ROUTER_TOKENS.<FEATURE>` and the service.
- Handler methods are decorated with `@Get`, `@Post`, `@Put`, `@Delete`.
- Pass `{ validate: ZodSchema }` to method decorators for request body validation.
- Pass `{ statusCode: 201 }` to override the default 200 status.
- Extract the authenticated user via `(req as unknown as IAuthenticatedRequest).user?.id`.
- Return the result directly — `BaseController` calls `res.json(result)` automatically.
- Every route must have a JSDoc `@swagger` comment block.

```typescript
import { inject, injectable } from 'tsyringe';
import express, { Request } from 'express';
import { BaseController, Controller, Get, Post, Delete } from '@/common/decorators/controller.decorator';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';
import FeatureService, { IFeatureService } from './feature.service';
import { CreateFeatureDTO, CreateFeatureSchema } from './feature.dto';
import { IAuthenticatedRequest } from '@/common/types/interface';

@injectable()
@Controller('/features')
class FeatureController extends BaseController {
  constructor(
    @inject(ROUTER_TOKENS.FEATURE) router: express.Router,
    @inject(FeatureService) private readonly featureService: IFeatureService,
  ) {
    super(router);
  }

  /**
   * @swagger
   * /features:
   *   post:
   *     tags: [Features]
   *     summary: Create a feature
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/CreateFeatureDTO'
   *     responses:
   *       '201':
   *         description: Feature created
   */
  @Post('/', { validate: CreateFeatureSchema, statusCode: 201 })
  async createFeature(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const payload = req.body as CreateFeatureDTO;
    return await this.featureService.createFeature(userId, payload);
  }
}

export default FeatureController;
```

### `<feature>.dependencies.ts` — DI wiring for the module

This is the only place where the module registers itself into the tsyringe container. It must:
1. Register a new `express.Router` factory under `ROUTER_TOKENS.<FEATURE>`.
2. Register the repository singleton under the string token `'IFeatureRepository'`.
3. Register the service and controller as singletons.
4. **Resolve the controller** so it mounts and registers its routes at startup.

```typescript
import express from 'express';
import { container } from 'tsyringe';
import FeatureController from './feature.controller';
import FeatureService from './feature.service';
import FeatureRepositoryImpl from './feature.repository';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';

export async function registerFeatureDependencies(): Promise<void> {
  container.register<express.Router>(ROUTER_TOKENS.FEATURE, {
    useFactory: () => express.Router(),
  });

  container.registerSingleton('IFeatureRepository', FeatureRepositoryImpl);
  container.registerSingleton<FeatureService>(FeatureService);
  container.registerSingleton<FeatureController>(FeatureController);

  container.resolve(FeatureController);
}
```

---

## Adding a New Module — Checklist

When adding a new feature module, complete every step in order:

- [ ] Create `src/modules/<feature>/` directory
- [ ] Write `<feature>.enum.ts`
- [ ] Write `<feature>.interface.ts`
- [ ] Write `<feature>.schema.ts` (Drizzle table)
- [ ] Write `<feature>.dto.ts` (Zod schemas + inferred types)
- [ ] Write `<feature>.repository.ts` (interface + impl)
- [ ] Write `<feature>.service.ts` (interface + impl)
- [ ] Write `<feature>.controller.ts` (extends BaseController, full Swagger JSDoc)
- [ ] Write `<feature>.dependencies.ts`
- [ ] Add `FEATURE: Symbol.for('FeatureRouter')` to `src/common/constants/router.tokens.ts`
- [ ] Add `/feature-path` to `authPrefixes` array in `authentication.middleware.ts`
- [ ] Import and call `registerFeatureDependencies()` in `src/init-dependencies.ts`
- [ ] Generate a migration: `npm run db:generate`
- [ ] Run the migration: `npm run db:migrate`

---

## DI Token Conventions

| Token type | Where defined | Pattern |
|---|---|---|
| App-level singletons | `app.tokens.ts` | `Symbol.for('ExpressApp')` |
| Module routers | `router.tokens.ts` | `Symbol.for('FeatureRouter')` |
| Repository interfaces | inline string | `'IFeatureRepository'` |

Always use `Symbol.for(...)` for typed tokens so they are globally unique and stable.

---

## Environment Variables

All environment variables are loaded once in `src/common/configuration/constants.ts` via `dotenv.config()` and exported as the `CONSTANTS` object. Never call `process.env` anywhere else in the application. If you need a new env var:

1. Add it to `.env` and `.env.production`
2. Add it to the `CONSTANTS` object in `constants.ts`
3. Reference it as `CONSTANTS.MY_VAR` throughout the codebase

---

## Error Handling

All custom exceptions are in `src/common/exception/index.ts`. Use these — never throw raw `Error` objects from service or controller code.

| Class | HTTP Code |
|---|---|
| `BadRequestException` | 400 |
| `UnAuthorizedException` | 401 |
| `ForbiddenException` | 403 |
| `ResourceNotFoundException` | 404 |
| `MethodNotAllowedException` | 405 |
| `ConflictException` | 409 |
| `InternalServerException` | 500 |

Pattern in services:
```typescript
} catch (error) {
  if (error instanceof ResourceNotFoundException) throw error; // re-throw known errors
  logger.error(`Context message - ${error}`);
  throw new InternalServerException('User-facing message.');
}
```

---

## Response Shapes

### Success — single resource
```json
{ "id": 1, "user_id": 42, "name": "..." }
```
(Return the DTO directly from the controller method.)

### Success — delete / action
```typescript
// IGeneralResponse<null>
{ "success": true, "message": "Resource deleted successfully", "data": null }
```

### Success — paginated list
```typescript
// IPagination<T>
{
  "page": 1,
  "limit": 20,
  "total_items": 100,
  "pages": 5,
  "items": [...]
}
```

### Error
```json
{ "statusCode": 404, "error": "Resource Not Found", "message": "Feature not found." }
```

---

## Authentication

- JWT Bearer token authentication is applied globally in `app.ts`.
- Routes under `/auth` are excluded from auth checking (login/register).
- All other API routes must be explicitly added to `authPrefixes` in `authentication.middleware.ts`.
- The authenticated user is available in controllers as:
  ```typescript
  const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
  ```

---

## Validation

Request validation uses Zod. Pass the schema to the method decorator:

```typescript
@Post('/', { validate: CreateFeatureSchema, statusCode: 201 })
async create(req: Request) { ... }
```

The `RequestValidationMiddleware.validate()` handles parsing and throws `BadRequestException` automatically if validation fails. The parsed value is written back to `req.body`.

For multi-part validation (body + params + query), pass an object:
```typescript
{ validate: { body: BodySchema, params: ParamsSchema, query: QuerySchema } }
```

---

## Database Migrations

Migrations are SQL files generated by Drizzle Kit and stored in `drizzle/`. They run automatically on startup via `db.migrate()`.

```bash
npm run db:generate   # Generate a new migration from schema changes
npm run db:migrate    # Apply pending migrations
npm run db:push       # Push schema directly to DB (dev only)
npm run db:studio     # Open Drizzle Studio GUI
```

Never hand-edit generated migration files. To make schema changes: edit the schema file, then re-run `db:generate`.

---

## Logging

Use the Winston logger from `@/common/lib/logger` everywhere. Never use `console.log` in production code.

```typescript
import logger from '@/common/lib/logger';

logger.info('Descriptive message with context');
logger.warn('Warning with context');
logger.error(`Error message - ${error}`);
```

---

## TypeScript Configuration

Key `tsconfig.json` settings to preserve:

```json
{
  "experimentalDecorators": true,
  "emitDecoratorMetadata": true,
  "useDefineForClassFields": false
}
```

`useDefineForClassFields: false` is required for tsyringe decorators to work correctly. Do not remove it.

The path alias `@/*` maps to `src/*`. Use `@/` imports throughout the codebase instead of relative paths.

---

## NPM Scripts

```bash
npm run dev         # Start dev server with hot reload (ts-node + nodemon)
npm run build       # Compile TypeScript to dist/
npm start           # Run compiled output
npm run lint        # Run ESLint
npm run lint:fix    # Run ESLint with auto-fix
npm run format      # Run Prettier
```

---

## Code Quality

- Husky runs `lint-staged` on every commit (ESLint fix + Prettier).
- ESLint config is in `eslint.config.mjs`.
- Prettier config is in `.prettierrc`.
- Never skip hooks with `--no-verify`.

---

## Swagger / API Docs

Every controller method must have a `@swagger` JSDoc comment block. The docs are served at `/api-docs` (excluded from authentication). The Swagger spec is assembled at startup via `setupSwagger(app)`.

Shared response components (`Unauthorized`, `NotFound`, `BadRequest`, `InternalServerError`) and security schemes (`bearerAuth`) are defined in `src/common/lib/swagger/swagger.yaml`. Reference them with `$ref` rather than repeating the schema inline.