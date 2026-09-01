import { inject, injectable } from 'tsyringe';
import OpenAI from 'openai';
import { CONSTANTS } from '@/common/configuration/constants';
import logger from '@/common/lib/logger';
import { IIrisRepository } from '../iris.repository';
import { IrisChunkTypeEnum } from '../iris.enum';
import { ITransactionRepository } from '@/modules/transaction/transaction.repository';
import { IBudgetRepository } from '@/modules/budget/budget.repository';
import { IGoalRepository } from '@/modules/goal/goal.repository';

export interface IEmbeddingService {
  embed(text: string): Promise<number[]>;
  rebuildForUser(userId: number): Promise<void>;
}

@injectable()
class EmbeddingService implements IEmbeddingService {
  private openai: OpenAI;

  constructor(
    @inject('IIrisRepository') private irisRepository: IIrisRepository,
    @inject('ITransactionRepository') private transactionRepository: ITransactionRepository,
    @inject('IBudgetRepository') private budgetRepository: IBudgetRepository,
    @inject('IGoalRepository') private goalRepository: IGoalRepository,
  ) {
    this.openai = new OpenAI({ apiKey: CONSTANTS.OPENAI_API_KEY });
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.openai.embeddings.create({
      model: CONSTANTS.OPENAI_EMBEDDINGS_MODEL,
      input: text,
      dimensions: CONSTANTS.IRIS_EMBEDDING_DIMENSIONS,
    });
    return response.data[0].embedding;
  }

  async rebuildForUser(userId: number): Promise<void> {
    try {
      const now = new Date();
      const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const threeMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 3, 1);

      const [currentTxns, last3MonthsTxns, budgets, goals] = await Promise.all([
        this.transactionRepository.findForSummary(userId, currentMonthStart, now),
        this.transactionRepository.findForSummary(userId, threeMonthsAgo, now),
        this.budgetRepository.findAllActive(userId),
        this.goalRepository.findAllByUser(userId),
      ]);

      const currency = currentTxns[0]?.refCurrency ?? last3MonthsTxns[0]?.refCurrency ?? 'NGN';
      const chunks: Array<{ chunkType: string; period: string; content: string }> = [];

      // Current month spending summary
      const currentDebits = currentTxns.filter((t) => t.amount < 0);
      const currentTotal = currentDebits.reduce((s, t) => s + Math.abs(t.refAmount), 0);
      const currentCategoryMap = currentDebits.reduce((acc: Record<string, number>, t) => {
        acc[t.category] = (acc[t.category] || 0) + Math.abs(t.refAmount);
        return acc;
      }, {});
      const topCurrentCategories = Object.entries(currentCategoryMap)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 8)
        .map(([cat, total]) => `${cat}: ${total.toFixed(2)}`)
        .join(', ');
      chunks.push({
        chunkType: IrisChunkTypeEnum.SPENDING_SUMMARY,
        period: 'current_month',
        content: `Current month spending: ${currentTotal.toFixed(2)} ${currency} across ${currentDebits.length} transactions. Top categories: ${topCurrentCategories || 'no data'}.`,
      });

      // Last 3 months spending summary
      const last3Debits = last3MonthsTxns.filter((t) => t.amount < 0);
      const last3Total = last3Debits.reduce((s, t) => s + Math.abs(t.refAmount), 0);
      chunks.push({
        chunkType: IrisChunkTypeEnum.SPENDING_SUMMARY,
        period: 'last_3_months',
        content: `Last 3 months spending: ${last3Total.toFixed(2)} ${currency} across ${last3Debits.length} transactions. Monthly average: ${(last3Total / 3).toFixed(2)} ${currency}.`,
      });

      // Budget summary
      if (budgets.length > 0) {
        const budgetLines = budgets.map((b) => {
          const spent = currentDebits
            .filter((t) => t.category === b.category)
            .reduce((s, t) => s + Math.abs(t.refAmount), 0);
          const pct = b.limitAmount > 0 ? ((spent / b.limitAmount) * 100).toFixed(0) : '0';
          return `${b.category}: ${spent.toFixed(2)} / ${b.limitAmount} ${currency} (${pct}% used)`;
        });
        chunks.push({
          chunkType: IrisChunkTypeEnum.BUDGET_SUMMARY,
          period: 'current_month',
          content: `Budget status this month: ${budgetLines.join('; ')}.`,
        });
      }

      // Goal summary
      if (goals.length > 0) {
        const goalLines = goals.map((g) => {
          const target = g.targetAmount ?? 0;
          const pct = target > 0 ? ((g.savedAmount / target) * 100).toFixed(0) : '0';
          return `${g.name} (${g.type}): ${g.savedAmount.toFixed(2)} / ${target} ${currency} (${pct}% saved)`;
        });
        chunks.push({
          chunkType: IrisChunkTypeEnum.GOAL_SUMMARY,
          period: 'current_month',
          content: `Financial goals: ${goalLines.join('; ')}.`,
        });
      }

      // Top merchant summary
      const merchantMap = last3Debits.reduce((acc: Record<string, number>, t) => {
        const name = t.merchant || 'Unknown';
        acc[name] = (acc[name] || 0) + Math.abs(t.refAmount);
        return acc;
      }, {});
      const topMerchants = Object.entries(merchantMap)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 15)
        .map(([merchant, total]) => `${merchant}: ${total.toFixed(2)} ${currency}`)
        .join('; ');
      if (topMerchants) {
        chunks.push({
          chunkType: IrisChunkTypeEnum.MERCHANT_SUMMARY,
          period: 'last_3_months',
          content: `Top merchants (last 3 months): ${topMerchants}.`,
        });
      }

      // Embed and upsert each chunk independently so one bad chunk doesn't
      // wipe out the rest of the user's rebuild.
      const results = await Promise.allSettled(
        chunks.map(async (chunk) => {
          const embedding = await this.embed(chunk.content);
          await this.irisRepository.upsertEmbedding({
            userId,
            chunkType: chunk.chunkType,
            period: chunk.period,
            content: chunk.content,
            embedding,
          });
        }),
      );

      const failures = results
        .map((result, i) => ({ result, chunk: chunks[i] }))
        .filter(({ result }) => result.status === 'rejected');
      for (const { result, chunk } of failures) {
        const reason = (result as PromiseRejectedResult).reason;
        logger.error(
          `Failed to embed Iris chunk for user ${userId} (${chunk.chunkType}/${chunk.period}) - ${reason}`,
        );
      }

      logger.info(
        `Iris embeddings rebuilt for user ${userId} (${chunks.length - failures.length}/${chunks.length} chunks).`,
      );
    } catch (error) {
      logger.error(`Failed to rebuild Iris embeddings for user ${userId} - ${error}`);
    }
  }
}

export default EmbeddingService;
