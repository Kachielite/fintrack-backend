import dotenv from 'dotenv';
dotenv.config();

export const CONSTANTS = {
  PORT: process.env.PORT || '3000',
  DATABASE_URL: process.env.DATABASE_URL as string,
  JWT_SECRET: process.env.JWT_SECRET as string,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '15m',
  JWT_REFRESH_EXPIRES_IN: '30d',

  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID as string,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET as string,
  GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI as string,

  APPLE_CLIENT_ID: process.env.APPLE_CLIENT_ID as string,
  APPLE_TEAM_ID: process.env.APPLE_TEAM_ID as string,
  APPLE_KEY_ID: process.env.APPLE_KEY_ID as string,
  APPLE_PRIVATE_KEY: process.env.APPLE_PRIVATE_KEY as string,

  OPENAI_API_KEY: process.env.OPENAI_API_KEY as string,
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o',

  OPEN_EXCHANGE_RATES_APP_ID: process.env.OPEN_EXCHANGE_RATES_APP_ID as string,

  TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY as string,

  GMAIL_POLL_INTERVAL_MINUTES: parseInt(process.env.GMAIL_POLL_INTERVAL_MINUTES || '15', 10),

  REGEX_PRODUCTION_THRESHOLD: parseFloat(process.env.REGEX_PRODUCTION_THRESHOLD || '0.85'),
  REGEX_REAUDIT_THRESHOLD: parseFloat(process.env.REGEX_REAUDIT_THRESHOLD || '0.60'),

  FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN || 'http://localhost:3001',

  ADMIN_JWT_SECRET: process.env.ADMIN_JWT_SECRET as string,
  ADMIN_JWT_EXPIRES_IN: process.env.ADMIN_JWT_EXPIRES_IN || '4h',

  OPENAI_COST_PER_1K_INPUT_TOKENS: parseFloat(process.env.OPENAI_COST_PER_1K_INPUT_TOKENS || '0.0025'),
  OPENAI_COST_PER_1K_OUTPUT_TOKENS: parseFloat(process.env.OPENAI_COST_PER_1K_OUTPUT_TOKENS || '0.010'),
};
