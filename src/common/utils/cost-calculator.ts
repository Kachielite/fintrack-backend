import { CONSTANTS } from '@/common/configuration/constants';

export function calculateCostUsd(promptTokens: number, completionTokens: number): number {
  const inputCost = (promptTokens / 1000) * CONSTANTS.OPENAI_COST_PER_1K_INPUT_TOKENS;
  const outputCost = (completionTokens / 1000) * CONSTANTS.OPENAI_COST_PER_1K_OUTPUT_TOKENS;
  return parseFloat((inputCost + outputCost).toFixed(6));
}
