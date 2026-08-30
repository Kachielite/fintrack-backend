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
import { IAiUsageRepository } from '@/modules/admin/admin.repository';
import NotificationService, { INotificationService } from '@/modules/notification/notification.service';

export interface IInsightService {
  listInsights(userId: number, query: InsightQueryDTO): Promise<IInsight[]>;
  markRead(id: number, userId: number): Promise<IInsight>;
  generateForUser(userId: number): Promise<void>;
}

// The current ISO week (Monday 00:00:00 through Sunday 23:59:59), used only to
// label/dedup the report by period — the analysis lookback below stays a
// generous 30-day trailing window regardless, for richer pattern detection.
function getCurrentWeekBounds(now: Date): { start: Date; end: Date } {
  const start = new Date(now);
  const day = start.getDay();
  const diffToMonday = day === 0 ? 6 : day - 1;
  start.setDate(start.getDate() - diffToMonday);
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  end.setHours(23, 59, 59, 999);

  return { start, end };
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
    @inject('IAiUsageRepository') private aiUsageRepository: IAiUsageRepository,
    @inject(NotificationService) private notificationService: INotificationService,
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

      const now = new Date();
      const { start: weekStart, end: weekEnd } = getCurrentWeekBounds(now);
      const alreadyGenerated = await this.insightRepository.hasReportForPeriod(userId, 'weekly', weekStart);
      if (alreadyGenerated) {
        logger.info(`Skipping insight generation for user ${userId} — already have this week's report`);
        return;
      }

      const thirtyDaysAgo = new Date(now);
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

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

      const debits = transactions.filter((t) => t.amount < 0);

      const top_merchants = Object.entries(
        debits.reduce((acc: Record<string, number>, t) => {
          const name = t.merchant || 'Unknown';
          acc[name] = (acc[name] || 0) + Math.abs(t.refAmount);
          return acc;
        }, {}),
      )
        .sort(([, a], [, b]) => b - a)
        .slice(0, 15)
        .map(([merchant, total]) => ({ merchant, total }));

      const top_categories = Object.entries(
        debits.reduce((acc: Record<string, number>, t) => {
          acc[t.category] = (acc[t.category] || 0) + Math.abs(t.refAmount);
          return acc;
        }, {}),
      )
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([cat, total]) => ({ category: cat, total }));

      const context = {
        total_spend_last_30_days: totalSpend,
        ref_currency: user.refCurrency,
        goal_type: user.goalType,
        advisor_tone: user.advisorTone,
        budget_progress: budgetProgress,
        goals: goals.map((g) => ({ name: g.name, type: g.type, target: g.targetAmount, saved: g.savedAmount })),
        top_categories,
        top_merchants,
      };

      const response = await this.openai.chat.completions.create({
        model: CONSTANTS.OPENAI_MODEL_INSIGHT,
        messages: [
          {
            role: 'system',
            content: `You are Iris, a warm and non-judgmental personal financial advisor. You read a user's spending data and write ONE concise report — not a list of separate observations. It should read in about fifteen seconds, not like a document. You never shame. You always frame observations as opportunities.

The user's goal is ${user.goalType} and their preferred tone is ${user.advisorTone}.

Use top_merchants (real merchant names like Glovo, Netflix, Cloudflare, etc.) to name specific merchants when relevant, even when the category is "other".

Be selective. Pick the 2-3 sharpest, most specific findings in the data — do not try to cover every category evenly. Skip anything unremarkable.

Return a JSON object: { "report": { ...report object... } }

The report object must have:
- "headline": ONE punchy sentence capturing the single most important thing this period. Max 15 words. e.g. "Your weekend food spend is 3× your weekday average."
- "findings": array of 2-3 short, specific, quantified findings (strings), each 1-2 sentences. e.g. "You spent ₦42,000 at Glovo this month, up 60% from last month."
- "chart_type": "bar_by_category" | "bar_by_merchant" | null
- "chart_data": array of { "label": string, "value": number, "highlight": boolean } — 5–7 items, sorted descending by value, illustrating whichever finding the chart best supports. highlight=true for the notable ones. null if chart_type is null.
- "closing": 1-2 sentence closing paragraph that explicitly compares this period's spending against the user's real goals (the "goals" array — name a goal by name when relevant). If "goals" is empty, gently note that setting one would help, without being pushy.
- "goal_alignment": { "status": one of "on_track" | "ahead" | "behind" | "no_goals", "summary": one sentence explaining the status, naming a specific goal when possible }

Return JSON only.`,
          },
          {
            role: 'user',
            content: `Generate a financial report for this user: ${JSON.stringify(context)}`,
          },
        ],
        response_format: { type: 'json_object' },
      });

      if (response.usage) {
        this.aiUsageRepository.log({
          operation: 'generate_insight',
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
          modelUsed: CONSTANTS.OPENAI_MODEL_INSIGHT,
          userId: userId,
        }).catch(() => null);
      }

      const raw = JSON.parse(response.choices[0].message.content || '{}');
      const report: {
        headline?: string;
        findings?: string[];
        chart_type?: string | null;
        chart_data?: { label: string; value: number; highlight: boolean }[] | null;
        closing?: string;
        goal_alignment?: { status?: string; summary?: string };
      } = raw.report || raw;

      if (!report.headline) {
        logger.warn(`Insight generation for user ${userId} returned no headline — skipping`);
        await this.insightRepository.deleteExpired(userId);
        return;
      }

      const expiry = new Date();
      expiry.setDate(expiry.getDate() + 7);

      await this.insightRepository.create({
        userId,
        type: InsightTypeEnum.REPORT,
        message: report.headline,
        contextData: {
          headline: report.headline,
          findings: report.findings ?? [],
          chart_type: report.chart_type ?? null,
          chart_data: report.chart_data ?? null,
          closing: report.closing ?? null,
          goal_alignment: {
            status: report.goal_alignment?.status ?? (goals.length > 0 ? 'behind' : 'no_goals'),
            summary: report.goal_alignment?.summary ?? '',
          },
        },
        periodType: 'weekly',
        periodStart: weekStart,
        periodEnd: weekEnd,
        expiresAt: expiry,
      });

      await this.insightRepository.deleteExpired(userId);
      logger.info(`Insight report generated for user ${userId}`);

      this.notificationService.create({
        userId,
        type: 'insight_generated',
        title: 'Iris has new insights for you',
        body: 'Your weekly financial summary is ready. Tap to see what Iris found.',
        data: {},
      }).catch(() => {});
    } catch (error) {
      logger.error(`Error generating insights for user ${userId} - ${error}`);
    }
  }
}

export default InsightService;
