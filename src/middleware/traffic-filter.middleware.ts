import rateLimit from 'express-rate-limit';
import { Request, Response, NextFunction } from 'express';

const PROBE_PATHS = ['/wp-admin', '/wp-login', '/.env', '/phpinfo', '/config.php', '/admin.php'];

export const rateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { statusCode: 429, error: 'Too Many Requests', message: 'Rate limit exceeded' },
});

export function probeBlocker(req: Request, res: Response, next: NextFunction): void {
  if (PROBE_PATHS.some((p) => req.path.startsWith(p))) {
    res.status(403).json({ statusCode: 403, error: 'Forbidden', message: 'Access denied' });
    return;
  }
  next();
}
