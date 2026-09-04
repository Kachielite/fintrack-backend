import { CONSTANTS } from '@/common/configuration/constants';
import logger from '@/common/lib/logger';

// Keyed by the exact model name strings that appear in ai_usage_logs.model_used
// - CONSTANTS.OPENAI_MODEL_* resolve to one of these under normal operation,
// though an env override could in principle set a different model name (see
// the fallback below). See fintrack-backend#141.
const MODEL_PRICING: Record<string, { inputPer1k: number; outputPer1k: number }> = {
  'gpt-4o': {
    inputPer1k: CONSTANTS.OPENAI_COST_PER_1K_INPUT_TOKENS,
    outputPer1k: CONSTANTS.OPENAI_COST_PER_1K_OUTPUT_TOKENS,
  },
  'gpt-4o-mini': {
    inputPer1k: CONSTANTS.OPENAI_MINI_COST_PER_1K_INPUT_TOKENS,
    outputPer1k: CONSTANTS.OPENAI_MINI_COST_PER_1K_OUTPUT_TOKENS,
  },
};

/**
 * `model` is optional for backward compatibility with callers that only have
 * an aggregate token count with no per-model breakdown (e.g. getOverview's
 * blended today/month cost) - those keep using gpt-4o pricing, same as
 * before this function became model-aware. Callers that do have a real
 * model_used value (the AI Usage dashboard, since fintrack-backend#141) get
 * accurate per-model pricing. A model name outside the table (e.g. a future
 * model swapped in via an OPENAI_MODEL_* env override) falls back to gpt-4o
 * pricing with a warning instead of silently mispricing or throwing.
 */
export function calculateCostUsd(promptTokens: number, completionTokens: number, model?: string): number {
  const pricing = model ? MODEL_PRICING[model] : undefined;
  if (model && !pricing) {
    logger.warn(`[CostCalculator] Unknown model "${model}" - falling back to gpt-4o pricing`);
  }
  const effective = pricing ?? MODEL_PRICING['gpt-4o'];
  const inputCost = (promptTokens / 1000) * effective.inputPer1k;
  const outputCost = (completionTokens / 1000) * effective.outputPer1k;
  return parseFloat((inputCost + outputCost).toFixed(6));
}
