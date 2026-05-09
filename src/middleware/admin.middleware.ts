import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { CONSTANTS } from '@/common/configuration/constants';
import { UnAuthorizedException } from '@/common/exception';

export function adminAuthMiddleware(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    throw new UnAuthorizedException('Admin access denied.');
  }
  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, CONSTANTS.ADMIN_JWT_SECRET) as { role: string; adminId: number };
    if (payload.role !== 'admin') throw new Error();
    (req as any).adminId = payload.adminId;
    next();
  } catch {
    throw new UnAuthorizedException('Admin access denied.');
  }
}
