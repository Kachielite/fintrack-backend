import winston from 'winston';
import path from 'path';

const APP_LABEL = 'FinTrack 🚀';

const consoleFormat = winston.format.printf(({ level, message, timestamp }) => {
  const time = new Date(timestamp as string).toTimeString().slice(0, 8);
  return `[${time}] ${APP_LABEL}  ${level}  ${message}`;
});

const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.File({ filename: path.join('logs', 'error.log'), level: 'error' }),
    new winston.transports.File({ filename: path.join('logs', 'combined.log') }),
  ],
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(winston.format.timestamp(), consoleFormat),
    }),
  );
}

export default logger;
