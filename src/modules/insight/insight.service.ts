import { inject, injectable } from 'tsyringe';
import OpenAI from 'openai';
import { CONSTANTS } from '@/common/configuration/constants';
import logger from '@/common/lib/logger';
import { IInsightRepository } from './insight.repository';
import { IInsight } from './insight.interface';
import { InsightQueryDTO } from './insight.dto';
import { InsightTypeEnum } from './insight.enum';
import { ITransactionRepository } from '@/modules/transaction/transaction.repository';
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
  generateWeeklyReportForUser(userId: number): Promise<void>;
  generateMonthlyReportForUser(userId: number): Promise<void>;
  canGenerateWeeklyReport(userId: number): Promise<boolean>;
}

interface ChartPoint {
  label: string;
  value: number;
  highlight: boolean;
}

interface Chart {
  type: string;
  data: ChartPoint[];
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

// The calendar month `monthsAgo` months before `now` (1 = last month, 2 = the
// month before that), full boundaries.
function getMonthBounds(now: Date, monthsAgo: number): { start: Date; end: Date } {
  const start = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 1, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth() - monthsAgo + 1, 0, 23, 59, 59, 999);
  return { start, end };
}

function monthsBetween(from: Date, to: Date): number {
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}

// "Aug 17–23", or "Aug 28–Sep 3" when the week spans a month boundary.
function formatWeeklyPeriodLabel(start: Date, end: Date): string {
  const startLabel = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const endLabel = start.getMonth() === end.getMonth()
    ? end.toLocaleDateString('en-US', { day: 'numeric' })
    : end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${startLabel}–${endLabel}`;
}

// "August"
function formatMonthlyPeriodLabel(start: Date): string {
  return start.toLocaleDateString('en-US', { month: 'long' });
}

@injectable()
class InsightService implements IInsightService {
  private openai: OpenAI;
  // Guards against a second weekly generation slipping in while the first is
  // still running — hasReportForPeriod alone can't catch that, since the row
  // it checks for doesn't exist until generation finishes.
  private weeklyGenerationInProgress = new Set<number>();

  constructor(
    @inject('IInsightRepository') private insightRepository: IInsightRepository,
    @inject('ITransactionRepository') private transactionRepository: ITransactionRepository,
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

  private summarizeSpend(transactions: { amount: number; refAmount: number; category: string; merchant: string }[]) {
    const totalSpend = transactions
      .filter((t) => t.amount < 0)
      .reduce((acc, t) => acc + Math.abs(t.refAmount), 0);

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

    return { totalSpend, top_categories, top_merchants };
  }

  async canGenerateWeeklyReport(userId: number): Promise<boolean> {
    if (this.weeklyGenerationInProgress.has(userId)) return false;
    const { start } = getCurrentWeekBounds(new Date());
    const alreadyGenerated = await this.insightRepository.hasReportForPeriod(userId, 'weekly', start);
    return !alreadyGenerated;
  }

  async generateWeeklyReportForUser(userId: number): Promise<void> {
    this.weeklyGenerationInProgress.add(userId);
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

      const [transactions, goals] = await Promise.all([
        this.transactionRepository.findForSummary(userId, thirtyDaysAgo, now),
        this.goalRepository.findAllByUser(userId),
      ]);

      const { totalSpend, top_categories, top_merchants } = this.summarizeSpend(transactions);

      const context = {
        total_spend_last_30_days: totalSpend,
        ref_currency: user.refCurrency,
        goal_type: user.goalType,
        advisor_tone: user.advisorTone,
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

      const charts: Chart[] = report.chart_type && report.chart_data
        ? [{ type: report.chart_type, data: report.chart_data }]
        : [];

      await this.insightRepository.create({
        userId,
        type: InsightTypeEnum.REPORT,
        message: report.headline,
        contextData: {
          headline: report.headline,
          findings: report.findings ?? [],
          chart_type: report.chart_type ?? null,
          chart_data: report.chart_data ?? null,
          charts,
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
      logger.info(`Weekly insight report generated for user ${userId}`);

      this.notificationService.create({
        userId,
        type: 'insight_generated',
        title: 'Iris has new insights for you',
        body: `Your weekly report (${formatWeeklyPeriodLabel(weekStart, weekEnd)}) is ready. Tap to see what Iris found.`,
        data: {},
      }).catch(() => {});
    } catch (error) {
      logger.error(`Error generating weekly insight report for user ${userId} - ${error}`);
    } finally {
      this.weeklyGenerationInProgress.delete(userId);
    }
  }

  async generateMonthlyReportForUser(userId: number): Promise<void> {
    try {
      const user = await this.userRepository.findById(userId);
      if (!user) return;

      const now = new Date();
      const { start: monthStart, end: monthEnd } = getMonthBounds(now, 1);
      const alreadyGenerated = await this.insightRepository.hasReportForPeriod(userId, 'monthly', monthStart);
      if (alreadyGenerated) {
        logger.info(`Skipping monthly insight generation for user ${userId} — already have this month's report`);
        return;
      }

      const { start: priorMonthStart, end: priorMonthEnd } = getMonthBounds(now, 2);

      const [transactions, priorMonthTransactions, goals] = await Promise.all([
        this.transactionRepository.findForSummary(userId, monthStart, monthEnd),
        this.transactionRepository.findForSummary(userId, priorMonthStart, priorMonthEnd),
        this.goalRepository.findAllByUser(userId),
      ]);

      const { totalSpend, top_categories, top_merchants } = this.summarizeSpend(transactions);
      const { totalSpend: priorTotalSpend, top_categories: priorTopCategories } = this.summarizeSpend(priorMonthTransactions);

      const spendChangePct = priorTotalSpend > 0
        ? Math.round(((totalSpend - priorTotalSpend) / priorTotalSpend) * 1000) / 10
        : null;

      const goalsContext = goals.map((g) => {
        const monthsRemaining = g.targetDate ? Math.max(1, monthsBetween(now, g.targetDate)) : null;
        const requiredMonthlyPace = g.targetAmount != null && monthsRemaining
          ? (g.targetAmount - g.savedAmount) / monthsRemaining
          : null;
        return {
          name: g.name,
          type: g.type,
          target: g.targetAmount,
          saved: g.savedAmount,
          months_remaining: monthsRemaining,
          required_monthly_pace: requiredMonthlyPace,
        };
      });

      const context = {
        period_total_spend: totalSpend,
        prior_period_total_spend: priorTotalSpend,
        spend_change_pct: spendChangePct,
        ref_currency: user.refCurrency,
        goal_type: user.goalType,
        advisor_tone: user.advisorTone,
        goals: goalsContext,
        top_categories,
        top_merchants,
        prior_period_top_categories: priorTopCategories,
      };

      const response = await this.openai.chat.completions.create({
        model: CONSTANTS.OPENAI_MODEL_INSIGHT,
        messages: [
          {
            role: 'system',
            content: `You are Iris, a warm and non-judgmental personal financial advisor. You read a full month of a user's spending data and write ONE concise monthly report — a narrative, not a document. It should still read in well under a minute. You never shame. You always frame observations as opportunities.

The user's goal is ${user.goalType} and their preferred tone is ${user.advisorTone}.

Use top_merchants (real merchant names like Glovo, Netflix, Cloudflare, etc.) to name specific merchants when relevant, even when the category is "other". Use prior_period_total_spend, prior_period_top_categories, and spend_change_pct to explicitly compare this month against last month — that comparison is the point of a monthly report.

Be selective. Pick the 2-3 sharpest, most specific findings — do not try to cover every category evenly.

Return a JSON object: { "report": { ...report object... } }

The report object must have:
- "headline": ONE punchy sentence capturing the single most important thing this month, ideally naming the trend vs last month. Max 15 words.
- "findings": array of 2-3 short, specific, quantified findings (strings), each 1-2 sentences, at least one of which references the month-over-month trend.
- "closing": 2-3 sentence closing narrative that explicitly compares this month's spending against the user's real goals (the "goals" array — name a goal by name when relevant, referencing required_monthly_pace where available). If "goals" is empty, gently note that setting one would help, without being pushy.
- "goal_alignment": { "status": one of "on_track" | "ahead" | "behind" | "no_goals", "delta_amount": a number in ${user.refCurrency} estimating how far off the required_monthly_pace this month's spending puts them (positive if behind, negative or 0 if ahead/on track; null if no_goals), "summary": one sentence explaining the status, naming a specific goal and the delta_amount when possible }

Do not return chart_type or chart_data — charts for this report are generated separately.

Return JSON only.`,
          },
          {
            role: 'user',
            content: `Generate a monthly financial report for this user: ${JSON.stringify(context)}`,
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
        closing?: string;
        goal_alignment?: { status?: string; delta_amount?: number | null; summary?: string };
      } = raw.report || raw;

      if (!report.headline) {
        logger.warn(`Monthly insight generation for user ${userId} returned no headline — skipping`);
        await this.insightRepository.deleteExpired(userId);
        return;
      }

      // Charts are computed server-side from real numbers rather than asked of
      // the model, since we already have the exact figures on hand.
      const categoryChart: Chart | null = top_categories.length > 0
        ? {
            type: 'bar_by_category',
            data: top_categories.slice(0, 7).map((c, i) => ({ label: c.category, value: c.total, highlight: i === 0 })),
          }
        : null;
      const trendChart = this.weeklyTrendChart(transactions, monthStart, monthEnd);
      const charts: Chart[] = [categoryChart, trendChart].filter((c): c is Chart => c !== null);

      const expiry = new Date();
      expiry.setDate(expiry.getDate() + 35);

      await this.insightRepository.create({
        userId,
        type: InsightTypeEnum.REPORT,
        message: report.headline,
        contextData: {
          headline: report.headline,
          findings: report.findings ?? [],
          chart_type: charts[0]?.type ?? null,
          chart_data: charts[0]?.data ?? null,
          charts,
          closing: report.closing ?? null,
          goal_alignment: {
            status: report.goal_alignment?.status ?? (goals.length > 0 ? 'behind' : 'no_goals'),
            delta_amount: report.goal_alignment?.delta_amount ?? null,
            summary: report.goal_alignment?.summary ?? '',
          },
        },
        periodType: 'monthly',
        periodStart: monthStart,
        periodEnd: monthEnd,
        expiresAt: expiry,
      });

      await this.insightRepository.deleteExpired(userId);
      logger.info(`Monthly insight report generated for user ${userId}`);

      this.notificationService.create({
        userId,
        type: 'insight_generated',
        title: 'Iris has new insights for you',
        body: `Your ${formatMonthlyPeriodLabel(monthStart)} report is ready. Tap to see what Iris found.`,
        data: {},
      }).catch(() => {});
    } catch (error) {
      logger.error(`Error generating monthly insight report for user ${userId} - ${error}`);
    }
  }

  // Deterministic week-by-week spend total within a single month, used as the
  // monthly report's second chart (trend vs. category breakdown).
  private weeklyTrendChart(
    transactions: { amount: number; refAmount: number; transactionDate: Date }[],
    monthStart: Date,
    monthEnd: Date,
  ): Chart | null {
    const debits = transactions.filter((t) => t.amount < 0);
    if (debits.length === 0) return null;

    const daysInMonth = monthEnd.getDate();
    const numWeeks = Math.ceil(daysInMonth / 7);
    const totals = new Array(numWeeks).fill(0);

    for (const t of debits) {
      const dayOfMonth = new Date(t.transactionDate).getDate();
      const weekIdx = Math.min(Math.floor((dayOfMonth - 1) / 7), numWeeks - 1);
      totals[weekIdx] += Math.abs(t.refAmount);
    }

    const max = Math.max(...totals);
    const data: ChartPoint[] = totals.map((value, i) => ({
      label: `Week ${i + 1}`,
      value,
      highlight: value === max,
    }));

    return { type: 'trend_by_week', data };
  }
}

export default InsightService;
