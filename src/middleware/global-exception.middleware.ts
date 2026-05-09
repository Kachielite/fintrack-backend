import { Request, Response, NextFunction } from 'express';
import { HttpError } from '@/common/exception/http-error';
import logger from '@/common/lib/logger';

export function resourceNotFoundHandler(req: Request, res: Response, _next: NextFunction): void {
  res.status(404).json({
    statusCode: 404,
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`,
  });
}

export function allExceptionHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof HttpError) {
    res.status(err.statusCode).json(err.toJSON());
    return;
  }

  logger.error(`Unhandled error - ${err.message}`, { stack: err.stack });
  res.status(500).json({
    statusCode: 500,
    error: 'Internal Server Error',
    message: 'An unexpected error occurred',
  });
}
