import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { injectable } from 'tsyringe';
import { CONSTANTS } from '@/common/configuration/constants';
import { UnAuthorizedException } from '@/common/exception';
import { IAuthenticatedRequest } from '@/common/types/interface';

// Paths that are always public even if they fall under an auth prefix
const authExclusions: Array<{ path: string; method: string }> = [
  { path: '/api/email-connections/google/callback', method: 'GET' },
];

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
  '/api/notifications',
  '/api/iris',
];

@injectable()
class AuthenticationMiddleware {
  authenticate = (req: Request, res: Response, next: NextFunction): void => {
    const isExcluded = authExclusions.some(
      (e) => req.path === e.path && req.method === e.method,
    );
    if (isExcluded) return next();

    const requiresAuth = authPrefixes.some((prefix) => req.path.startsWith(prefix));
    if (!requiresAuth) return next();

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return next(new UnAuthorizedException('No token provided'));
    }

    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, CONSTANTS.JWT_SECRET) as { id: number; email: string };
      (req as unknown as IAuthenticatedRequest).user = { id: decoded.id, email: decoded.email };
      next();
    } catch {
      next(new UnAuthorizedException('Invalid or expired token'));
    }
  };
}

export default AuthenticationMiddleware;
