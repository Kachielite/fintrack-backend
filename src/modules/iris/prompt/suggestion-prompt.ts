export function buildSuggestionPrompt(financialSnapshot: string): string {
  return `You are Iris, a personal financial advisor AI.
Based on the following financial context, generate exactly 4 short, specific question suggestions a user might want to ask about their finances.
Each suggestion must be 5-10 words and feel personal to their actual data.

Financial context:
${financialSnapshot}

Return a JSON object:
{
  "suggestions": ["question 1", "question 2", "question 3", "question 4"]
}

Return JSON only.`;
}
