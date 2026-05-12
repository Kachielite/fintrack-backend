import winston from 'winston';
import path from 'path';

const APP_LABEL = 'FinTrack 🚀';

const consoleFormat = winston.format.printf(({ level, message, timestamp }) => {
  const time = new Date(timestamp as string).toTimeString().slice(0, 8);
  return `[${time}] ${APP_LABEL}  ${level}  ${message}`;
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
