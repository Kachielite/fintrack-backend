import winston from 'winston';
import path from 'path';

const APP_LABEL = 'FinTrack 🚀';

const LEVEL_COLORS: Record<string, string> = {
  error: '\x1b[31m',
  warn:  '\x1b[33m',
  info:  '\x1b[36m',
  debug: '\x1b[90m',
};
const RESET = '\x1b[0m';

const consoleFormat = winston.format.printf(({ level, message, timestamp }) => {
  const time = new Date(timestamp as string).toTimeString().slice(0, 8);
  const color = LEVEL_COLORS[level] ?? '';
  return `[${time}] ${APP_LABEL}  ${color}${level}${RESET}  ${message}`;
});

const isProduction = process.env.NODE_ENV === 'production';

const logger = winston.createLogger({
  level: isProduction ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  transports: [
    // Always log to stdout so docker logs / hosted platform log tails work
    new winston.transports.Console({
      format: winston.format.combine(winston.format.timestamp(), consoleFormat),
    }),
    // File transports for local dev convenience (gitignored)
    new winston.transports.File({ filename: path.join('logs', 'error.log'), level: 'error' }),
    new winston.transports.File({ filename: path.join('logs', 'combined.log') }),
  ],
});

export default logger;
