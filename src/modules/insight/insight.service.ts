import { inject, injectable } from 'tsyringe';
import OpenAI from 'openai';
import { CONSTANTS } from '@/common/configuration/constants';
import logger from '@/common/lib/logger';
import { IInsightRepository } from './insight.repository';
import { IInsight } from './insight.interface';
import { InsightQueryDTO } from './insight.dto';
import { InsightTypeEnum } from './insight.enum';
import { ITransactionRepository } from '@/modules/transaction/transaction.repository';
import { IBudgetRepository } from '@/modules/budget/budget.repository';
import { IGoalRepository } from '@/modules/goal/goal.repository';
import { IExchangeRateService } from '@/modules/exchange-rate/exchange-rate.service';
import { IUserRepository } from '@/modules/user/user.repository';
import { InternalServerException } from '@/common/exception';
import ExchangeRateService from '@/modules/exchange-rate/exchange-rate.service';

export interface IInsightService {
  listInsights(userId: number, query: InsightQueryDTO): Promise<IInsight[]>;
  markRead(id: number, userId: number): Promise<IInsight>;
  generateForUser(userId: number): Promise<void>;
}

@injectable()
class InsightService implements IInsightService {
  private openai: OpenAI;

  constructor(
    @inject('IInsightRepository') private insightRepository: IInsightRepository,
    @inject('ITransactionRepository') private transactionRepository: ITransactionRepository,
    @inject('IBudgetRepository') private budgetRepository: IBudgetRepository,
    @inject('IGoalRepository') private goalRepository: IGoalRepository,
    @inject(ExchangeRateService) private exchangeRateService: IExchangeRateService,
    @inject('IUserRepository') private userRepository: IUserRepository,
  ) {
    this.openai = new OpenAI({ apiKey: CONSTANTS.OPENAI_API_KEY });
  }

  async listInsights(userId: number, query: InsightQueryDTO): Promise<IInsight[]> {
    try {
      return await this.insightRepository.findActive(userId, query.unread_only);
    } catch (error) {
      logger.error(`Error listing insights for user ${userId} - ${error}`);
      throw new InternalServerException('Failed to list insights');
    }
  }

  async markRead(id: number, userId: number): Promise<IInsight> {
    try {
      await this.insightRepository.markRead(id, userId);
      const insights = await this.insightRepository.findActive(userId, false);
      const insight = insights.find((i) => i.id === id);
      if (!insight) throw new InternalServerException('Insight not found after update');
      return insight;
    } catch (error) {
      logger.error(`Error marking insight ${id} read - ${error}`);
      throw new InternalServerException('Failed to mark insight as read');
    }
  }

  async generateForUser(userId: number): Promise<void> {
    try {
      const user = await this.userRepository.findById(userId);
      if (!user) return;

      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const now = new Date();

      const [transactions, budgets, goals] = await Promise.all([
        this.transactionRepository.findForSummary(userId, thirtyDaysAgo, now),
        this.budgetRepository.findAllActive(userId),
        this.goalRepository.findAllByUser(userId),
      ]);

      const totalSpend = transactions
        .filter((t) => t.amount < 0)
        .reduce((acc, t) => acc + Math.abs(t.refAmount), 0);

      const budgetProgress = await Promise.all(
        budgets.map(async (b) => {
          const spent = transactions
            .filter((t) => t.category === b.category && t.amount < 0)
            .reduce((acc, t) => acc + Math.abs(t.refAmount), 0);
          return { category: b.category, limit: b.limitAmount, spent, percentage: (spent / b.limitAmount) * 100 };
        }),
      );

      const context = {
        total_spend_last_30_days: totalSpend,
        ref_currency: user.refCurrency,
        goal_type: user.goalType,
        advisor_tone: user.advisorTone,
        budget_progress: budgetProgress,
        goals: goals.map((g) => ({ name: g.name, type: g.type, target: g.targetAmount, saved: g.savedAmount })),
        top_categories: Object.entries(
          transactions
            .filter((t) => t.amount < 0)
            .reduce((acc: Record<string, number>, t) => {
              acc[t.category] = (acc[t.category] || 0) + Math.abs(t.refAmount);
              return acc;
            }, {}),
        )
          .sort(([, a], [, b]) => b - a)
          .slice(0, 5)
          .map(([cat, total]) => ({ category: cat, total })),
      };

      const response = await this.openai.chat.completions.create({
        model: CONSTANTS.OPENAI_MODEL,
        messages: [
          {
            role: 'system',
            content: `You are Iris, a warm and non-judgmental personal financial advisor. You observe patterns in a user's spending data and surface one to three insights that are specific, actionable, and forward-looking. You never shame. You always frame observations as opportunities. The user's goal is ${user.goalType} and their preferred tone is ${user.advisorTone}. Return a JSON array of insight objects: [{ type, message, context_data }]. Message must be 1–2 sentences. Return JSON only.`,
          },
          {
            role: 'user',
            content: `Generate financial insights for this user based on their data: ${JSON.stringify(context)}`,
          },
        ],
        response_format: { type: 'json_object' },
      });

      const raw = JSON.parse(response.choices[0].message.content || '{"insights":[]}');
      const insights: { type: string; message: string; context_data?: unknown }[] =
        raw.insights || raw;

      const expiry = new Date();
      expiry.setDate(expiry.getDate() + 7);

      const fortyEightHoursAgo = new Date();
      fortyEightHoursAgo.setHours(fortyEightHoursAgo.getHours() - 48);

      for (const insight of insights) {
        const type = Object.values(InsightTypeEnum).includes(insight.type as InsightTypeEnum)
          ? insight.type
          : InsightTypeEnum.SPENDING_PATTERN;

        const alreadyExists = await this.insightRepository.hasRecentInsight(
          userId,
          type,
          fortyEightHoursAgo,
        );
        if (alreadyExists) continue;

        await this.insightRepository.create({
          userId,
          type,
          message: insight.message,
          contextData: insight.context_data,
          expiresAt: expiry,
        });
      }

      await this.insightRepository.deleteExpired(userId);
      logger.info(`Insights generated for user ${userId}`);
    } catch (error) {
      logger.error(`Error generating insights for user ${userId} - ${error}`);
    }
  }
}

export default InsightService;
