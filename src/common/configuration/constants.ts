import dotenv from 'dotenv';
dotenv.config();

type OpenAIMode = 'quality' | 'cost' | 'balanced';

function normalizeOpenAIMode(value: string | undefined): OpenAIMode {
  const normalized = (value || 'balanced').toLowerCase();
  if (normalized === 'quality' || normalized === 'cost' || normalized === 'balanced') {
    return normalized;
  }
  return 'balanced';
}

function resolveModel(
  override: string | undefined,
  mode: OpenAIMode,
  byMode: Record<OpenAIMode, string>,
): string {
  if (override && override.toLowerCase() !== 'auto') return override;
  return byMode[mode];
}

const OPENAI_MODE = normalizeOpenAIMode(process.env.OPENAI_MODE);
const OPENAI_MODEL_DEFAULT = process.env.OPENAI_MODEL || 'gpt-4o';

export const CONSTANTS = {
  PORT: process.env.PORT || '3000',
  DATABASE_URL: process.env.DATABASE_URL as string,
  JWT_SECRET: process.env.JWT_SECRET as string,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '15m',
  JWT_REFRESH_EXPIRES_IN: '30d',

  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID as string,
  GOOGLE_WEB_CLIENT_ID: process.env.WEB_CLIENT_ID as string,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET as string,
  GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI as string,

  APPLE_CLIENT_ID: process.env.APPLE_CLIENT_ID as string,
  APPLE_TEAM_ID: process.env.APPLE_TEAM_ID as string,
  APPLE_KEY_ID: process.env.APPLE_KEY_ID as string,
  APPLE_PRIVATE_KEY: process.env.APPLE_PRIVATE_KEY as string,

  OPENAI_API_KEY: process.env.OPENAI_API_KEY as string,
  OPENAI_MODE,
  OPENAI_MODEL: OPENAI_MODEL_DEFAULT,
  // Use OPENAI_MODE profile unless an operation-specific override is provided.
  OPENAI_MODEL_EXTRACTION: resolveModel(process.env.OPENAI_MODEL_EXTRACTION, OPENAI_MODE, {
    quality: OPENAI_MODEL_DEFAULT,
    balanced: 'gpt-4o-mini',
    cost: 'gpt-4o-mini',
  }),
  OPENAI_MODEL_TEMPLATE: resolveModel(process.env.OPENAI_MODEL_TEMPLATE, OPENAI_MODE, {
    quality: OPENAI_MODEL_DEFAULT,
    balanced: OPENAI_MODEL_DEFAULT,
    cost: 'gpt-4o-mini',
  }),
  OPENAI_MODEL_AUDIT: resolveModel(process.env.OPENAI_MODEL_AUDIT, OPENAI_MODE, {
    quality: OPENAI_MODEL_DEFAULT,
    balanced: OPENAI_MODEL_DEFAULT,
    cost: 'gpt-4o-mini',
  }),
  OPENAI_MODEL_CLASSIFY: resolveModel(process.env.OPENAI_MODEL_CLASSIFY, OPENAI_MODE, {
    quality: OPENAI_MODEL_DEFAULT,
    balanced: 'gpt-4o-mini',
    cost: 'gpt-4o-mini',
  }),
  OPENAI_MODEL_BUDGET: resolveModel(process.env.OPENAI_MODEL_BUDGET, OPENAI_MODE, {
    quality: OPENAI_MODEL_DEFAULT,
    balanced: 'gpt-4o-mini',
    cost: 'gpt-4o-mini',
  }),
  OPENAI_MODEL_INSIGHT: resolveModel(process.env.OPENAI_MODEL_INSIGHT, OPENAI_MODE, {
    quality: OPENAI_MODEL_DEFAULT,
    balanced: OPENAI_MODEL_DEFAULT,
    cost: 'gpt-4o-mini',
  }),

  OPEN_EXCHANGE_RATES_APP_ID: process.env.OPEN_EXCHANGE_RATES_APP_ID as string,

  TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY as string,

  REDIS_URL: process.env.REDIS_URL || '',

  GMAIL_POLL_INTERVAL_MINUTES: parseInt(process.env.GMAIL_POLL_INTERVAL_MINUTES || '15', 10),

  REGEX_PRODUCTION_THRESHOLD: parseFloat(process.env.REGEX_PRODUCTION_THRESHOLD || '0.85'),
  REGEX_REAUDIT_THRESHOLD: parseFloat(process.env.REGEX_REAUDIT_THRESHOLD || '0.60'),

  FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN || 'http://localhost:3001',

  ADMIN_JWT_SECRET: process.env.ADMIN_JWT_SECRET as string,
  ADMIN_JWT_EXPIRES_IN: process.env.ADMIN_JWT_EXPIRES_IN || '4h',

  // OneSignal push notifications
  ONESIGNAL_APP_ID: process.env.ONESIGNAL_APP_ID || '',
  ONESIGNAL_REST_API_KEY: process.env.ONESIGNAL_REST_API_KEY || '',

  OPENAI_COST_PER_1K_INPUT_TOKENS: parseFloat(process.env.OPENAI_COST_PER_1K_INPUT_TOKENS || '0.0025'),
  OPENAI_COST_PER_1K_OUTPUT_TOKENS: parseFloat(process.env.OPENAI_COST_PER_1K_OUTPUT_TOKENS || '0.010'),

  OPENAI_EMBEDDINGS_MODEL: process.env.OPENAI_EMBEDDINGS_MODEL || 'text-embedding-3-small',
  IRIS_MAX_CONTEXT_MESSAGES: parseInt(process.env.IRIS_MAX_CONTEXT_MESSAGES || '10', 10),
  IRIS_EMBEDDING_DIMENSIONS: 1536,
  IRIS_RETRIEVAL_TOP_K: parseInt(process.env.IRIS_RETRIEVAL_TOP_K || '8', 10),

  FEATURES: {
    BUDGETING_ENABLED: process.env.FEATURE_BUDGETING_ENABLED === 'true',
  },
};
