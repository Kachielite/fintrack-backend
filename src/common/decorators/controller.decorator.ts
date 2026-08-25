import express, { Request, Response, NextFunction } from 'express';
import type { ZodSchema } from 'zod';
import { BadRequestException } from '@/common/exception';
import { registerMount } from '@/common/utils/route-registry';
import logger from '@/common/lib/logger';

type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

interface RouteOptions {
  validate?: ZodSchema | { body?: ZodSchema; params?: ZodSchema; query?: ZodSchema };
  statusCode?: number;
}

interface RouteMetadata {
  method: HttpMethod;
  path: string;
  handlerName: string;
  options: RouteOptions;
}

const ROUTES_KEY = Symbol('routes');

function createMethodDecorator(method: HttpMethod) {
  return (path: string, options: RouteOptions = {}) => {
    return (target: any, propertyKey: string, _descriptor: PropertyDescriptor) => {
      if (!Reflect.hasMetadata(ROUTES_KEY, target.constructor)) {
        Reflect.defineMetadata(ROUTES_KEY, [], target.constructor);
      }
      const routes: RouteMetadata[] = Reflect.getMetadata(ROUTES_KEY, target.constructor);
      routes.push({ method, path, handlerName: propertyKey, options });
    };
  };
}

export const Get = createMethodDecorator('get');
export const Post = createMethodDecorator('post');
export const Put = createMethodDecorator('put');
export const Patch = createMethodDecorator('patch');
export const Delete = createMethodDecorator('delete');

export function Controller(prefix: string) {
  return (target: any) => {
    Reflect.defineMetadata('prefix', prefix, target);
  };
}

function formatZodError(err: { issues?: { message: string }[]; errors?: { message: string }[] }): string {
  const issues = err.issues || err.errors || [];
  return issues.map((e) => e.message).join(', ');
}

function isZodSchema(v: unknown): v is ZodSchema {
  return typeof (v as any)?.safeParse === 'function' && !('body' in (v as any));
}

function buildValidationMiddleware(validate: RouteOptions['validate']) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!validate) return next();

      if (isZodSchema(validate)) {
        const schema = validate as ZodSchema;
        const result = schema.safeParse(req.body);
        if (!result.success) {
          throw new BadRequestException(formatZodError(result.error as any));
        }
        req.body = result.data;
      } else {
        const schemas = validate as { body?: ZodSchema; params?: ZodSchema; query?: ZodSchema };
        if (schemas.body) {
          const r = schemas.body.safeParse(req.body);
          if (!r.success) throw new BadRequestException(formatZodError(r.error as any));
          req.body = r.data;
        }
        if (schemas.params) {
          const r = schemas.params.safeParse(req.params);
          if (!r.success) throw new BadRequestException(formatZodError(r.error as any));
          (req as any).params = r.data;
        }
        if (schemas.query) {
          const r = schemas.query.safeParse(req.query);
          if (!r.success) throw new BadRequestException(formatZodError(r.error as any));
          res.locals.validatedQuery = r.data;
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Return this from a route handler instead of a plain object to bypass the
 * default res.json() wrapping — for CSV/file downloads and anything else
 * that isn't a JSON body. Every other handler is unaffected.
 */
export class RawResponse {
  constructor(
    public body: string,
    public contentType: string,
    public headers: Record<string, string> = {},
  ) {}
}

export class BaseController {
  protected router: express.Router;

  constructor(router: express.Router) {
    this.router = router;
    this.registerRoutes();
  }

  private registerRoutes(): void {
    const prefix: string = Reflect.getMetadata('prefix', this.constructor) || '';
    const routes: RouteMetadata[] = Reflect.getMetadata(ROUTES_KEY, this.constructor) || [];

    for (const route of routes) {
      const handler = (this as any)[route.handlerName].bind(this);
      const statusCode = route.options.statusCode || 200;
      const middleware = buildValidationMiddleware(route.options.validate);

      this.router[route.method](
        route.path,
        middleware,
        async (req: Request, res: Response, next: NextFunction) => {
          try {
            const requestForHandler = res.locals.validatedQuery === undefined
              ? req
              : ({
                  ...req,
                  query: res.locals.validatedQuery,
                } as Request);
            const result = await handler(requestForHandler);
            if (result instanceof RawResponse) {
              res.status(statusCode).set('Content-Type', result.contentType);
              for (const [key, value] of Object.entries(result.headers)) {
                res.set(key, value);
              }
              res.send(result.body);
            } else {
              res.status(statusCode).json(result);
            }
          } catch (err) {
            next(err);
          }
        },
      );
    }

    registerMount(`/api${prefix}`, this.router);

    const count = routes.length;
    const serviceName = this.constructor.name.replace('Controller', '');
    const noun = count === 1 ? 'endpoint' : 'endpoints';
    logger.info(`${serviceName} service started with ${count} ${noun} → /api${prefix}`);
  }
}
