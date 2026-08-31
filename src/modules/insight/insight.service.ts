import { inject, injectable } from 'tsyringe';
import OpenAI from 'openai';
import { CONSTANTS } from '@/common/configuration/constants';
import logger from '@/common/lib/logger';
import { IInsightRepository } from './insight.repository';
import { IInsight } from './insight.interface';
import { InsightQueryDTO } from './insight.dto';
import { InsightTypeEnum } from './insight.enum';
import { ITransactionRepository } from '@/modules/transaction/transaction.repository';
import { CategoryEnum } from '@/modules/transaction/transaction.enum';
import { IGoalRepository } from '@/modules/goal/goal.repository';
import { IGoal } from '@/modules/goal/goal.interface';
import { GoalTypeEnum } from '@/modules/user/user.enum';
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

// The 7 days immediately before weekStart (which is itself Monday 00:00:00).
function getPriorWeekBounds(weekStart: Date): { start: Date; end: Date } {
  const start = new Date(weekStart);
  start.setDate(start.getDate() - 7);

  const end = new Date(weekStart);
  end.setDate(end.getDate() - 1);
  end.setHours(23, 59, 59, 999);

  return { start, end };
}

// v1 simplification: a hardcoded, non-DB-driven classification of every
// CategoryEnum slug into needs/wants/neutral, used to frame essential vs.
// discretionary spend and to flag categories worth calling out. Not
// user-editable — a reasonable default set, not a hidden gap.
type CategoryClassification = 'essential' | 'discretionary' | 'neutral';

const CATEGORY_CLASSIFICATION: Record<string, CategoryClassification> = {
  [CategoryEnum.GROCERIES]: 'essential',
  [CategoryEnum.UTILITIES]: 'essential',
  [CategoryEnum.MOBILE_INTERNET]: 'essential',
  [CategoryEnum.TRANSPORT]: 'essential',
  [CategoryEnum.FUEL_AUTO]: 'essential',
  [CategoryEnum.RENT_HOUSING]: 'essential',
  [CategoryEnum.HEALTHCARE]: 'essential',
  [CategoryEnum.EDUCATION]: 'essential',
  [CategoryEnum.BANK_CHARGES]: 'essential',

  [CategoryEnum.SUBSCRIPTIONS]: 'discretionary',
  [CategoryEnum.ENTERTAINMENT_LEISURE]: 'discretionary',
  [CategoryEnum.RETAIL_ECOMMERCE]: 'discretionary',
  [CategoryEnum.DINING_FOOD_DELIVERY]: 'discretionary',
  [CategoryEnum.TRAVEL]: 'discretionary',
  [CategoryEnum.BEAUTY_PERSONAL_CARE]: 'discretionary',
  [CategoryEnum.GIFTS_SOCIAL]: 'discretionary',
  [CategoryEnum.CASH_WITHDRAWAL]: 'discretionary',

  [CategoryEnum.PEER_TO_PEER_TRANSFER]: 'neutral',
  [CategoryEnum.BUSINESS_PAYMENT]: 'neutral',
  [CategoryEnum.CURRENCY_CONVERSION]: 'neutral',
  [CategoryEnum.INVESTMENT]: 'neutral',
  [CategoryEnum.SAVINGS]: 'neutral',
  [CategoryEnum.SALARY_WAGES]: 'neutral',
  [CategoryEnum.REFUNDS_REIMBURSEMENTS]: 'neutral',
  [CategoryEnum.CHARITY_DONATIONS]: 'neutral',
  [CategoryEnum.FAMILY_SUPPORT]: 'neutral',
  [CategoryEnum.UNCATEGORIZED]: 'neutral',
};

function classify(category: string): CategoryClassification {
  return CATEGORY_CLASSIFICATION[category] ?? 'neutral';
}

// Parses one side of an income bucket like "200k", "1.5M", or a plain
// "15000" into a number. Returns NaN if unparseable.
function parseAmountToken(token: string): number {
  const match = token.trim().match(/^([\d.]+)\s*(k|m)?$/i);
  if (!match) return NaN;
  const value = parseFloat(match[1]);
  const suffix = match[2]?.toLowerCase();
  if (suffix === 'k') return value * 1_000;
  if (suffix === 'm') return value * 1_000_000;
  return value;
}

// Parses an onboarding income bucket ("0-200k", "600k-1.5M", "3M+", or a
// plain-number equivalent for non-NGN currencies) into a numeric midpoint.
// Open-ended buckets ("3M+") get roughly a +25% bump above the floor as a
// proxy midpoint. Working assumption: the bucket is a MONTHLY figure
// regardless of pay_frequency — a product judgment call, not derived from
// anything in the data.
function parseIncomeRangeMidpoint(range: string | null | undefined): number | null {
  if (!range) return null;
  const trimmed = range.trim();

  if (trimmed.endsWith('+')) {
    const floor = parseAmountToken(trimmed.slice(0, -1));
    return Number.isNaN(floor) ? null : floor * 1.25;
  }

  const parts = trimmed.split('-');
  if (parts.length !== 2) return null;

  const low = parseAmountToken(parts[0]);
  const high = parseAmountToken(parts[1]);
  if (Number.isNaN(low) || Number.isNaN(high)) return null;

  return (low + high) / 2;
}

// Real income for the period, summed from categorized salary/wages credits.
// Null (not 0) when there are none, so callers can distinguish "no income
// found" from "found income totalling zero."
function computeActualIncome(transactions: { amount: number; refAmount: number; category: string }[]): number | null {
  const total = transactions
    .filter((t) => t.amount > 0 && t.category === CategoryEnum.SALARY_WAGES)
    .reduce((acc, t) => acc + t.refAmount, 0);
  return total > 0 ? total : null;
}

interface IncomeContext {
  estimated_monthly_income: number | null;
  estimated_period_income: number | null;
  actual_period_income: number | null;
  income_for_period: number | null;
  income_source: 'actual' | 'estimated' | 'unknown';
}

function buildIncomeContext(
  incomeRange: string | null,
  periodTransactions: { amount: number; refAmount: number; category: string }[],
  periodType: 'weekly' | 'monthly',
): IncomeContext {
  const estimatedMonthlyIncome = parseIncomeRangeMidpoint(incomeRange);
  const estimatedPeriodIncome = estimatedMonthlyIncome == null
    ? null
    : periodType === 'weekly'
      ? estimatedMonthlyIncome / 4.345
      : estimatedMonthlyIncome;

  const actualPeriodIncome = computeActualIncome(periodTransactions);
  const incomeForPeriod = actualPeriodIncome ?? estimatedPeriodIncome;
  const incomeSource: IncomeContext['income_source'] =
    actualPeriodIncome != null ? 'actual' : estimatedPeriodIncome != null ? 'estimated' : 'unknown';

  return {
    estimated_monthly_income: estimatedMonthlyIncome,
    estimated_period_income: estimatedPeriodIncome,
    actual_period_income: actualPeriodIncome,
    income_for_period: incomeForPeriod,
    income_source: incomeSource,
  };
}

type Trend = 'up' | 'down' | 'flat' | 'new' | 'stopped';

interface DeltaRow {
  label: string;
  current_total: number;
  prior_total: number;
  pct_change: number | null;
  trend: Trend;
}

// Unions all keys from both periods (not just whatever was biggest this
// period) so a smaller category that spiked, or a merchant seen for the
// first time, can still surface. Returns the top `limit` rows by
// current-period size.
function buildDeltas(current: Record<string, number>, prior: Record<string, number>, limit: number): DeltaRow[] {
  const keys = new Set([...Object.keys(current), ...Object.keys(prior)]);
  const rows: DeltaRow[] = [];

  for (const key of keys) {
    const currentTotal = current[key] ?? 0;
    const priorTotal = prior[key] ?? 0;

    let trend: Trend;
    let pctChange: number | null = null;

    if (priorTotal === 0 && currentTotal > 0) {
      trend = 'new';
    } else if (priorTotal > 0 && currentTotal === 0) {
      trend = 'stopped';
    } else if (priorTotal === 0 && currentTotal === 0) {
      trend = 'flat';
    } else {
      pctChange = Math.round(((currentTotal - priorTotal) / priorTotal) * 1000) / 10;
      trend = pctChange > 5 ? 'up' : pctChange < -5 ? 'down' : 'flat';
    }

    rows.push({ label: key, current_total: currentTotal, prior_total: priorTotal, pct_change: pctChange, trend });
  }

  return rows.sort((a, b) => b.current_total - a.current_total).slice(0, limit);
}

interface CategoryDeltaRow extends DeltaRow {
  classification: CategoryClassification;
}

function buildCategoryDeltas(current: Record<string, number>, prior: Record<string, number>, limit: number): CategoryDeltaRow[] {
  return buildDeltas(current, prior, limit).map((row) => ({ ...row, classification: classify(row.label) }));
}

interface ClassificationSplit {
  essential: number;
  discretionary: number;
  neutral: number;
}

function splitByClassification(categoryTotals: Record<string, number>): ClassificationSplit {
  const result: ClassificationSplit = { essential: 0, discretionary: 0, neutral: 0 };
  for (const [category, total] of Object.entries(categoryTotals)) {
    result[classify(category)] += total;
  }
  return result;
}

interface RedFlag {
  category: string;
  amount: number;
  pct_of_income: number;
  pct_change_vs_prior: number | null;
}

// Categories the app has already decided are worth calling out — discretionary,
// trending up, and eating a meaningful share of income — so the model has
// strong candidates to lead with instead of defaulting to whichever category
// is biggest in absolute terms.
function computeRedFlags(categoryDeltas: CategoryDeltaRow[], incomeForPeriod: number | null): RedFlag[] {
  if (!incomeForPeriod) return [];

  return categoryDeltas
    .filter((row) => row.classification === 'discretionary' && row.trend === 'up' && row.current_total / incomeForPeriod > 0.08)
    .sort((a, b) => b.current_total - a.current_total)
    .slice(0, 3)
    .map((row) => ({
      category: row.label,
      amount: row.current_total,
      pct_of_income: Math.round((row.current_total / incomeForPeriod) * 1000) / 10,
      pct_change_vs_prior: row.pct_change,
    }));
}

// Distinct framing per goal type, replacing a bare ${user.goalType}
// interpolation — the four GoalTypeEnum values imply structurally different
// advice (specific has a real numeric target to pace against; the other
// three don't and shouldn't be treated as if they do).
function goalFramingInstructions(goalType: string | null | undefined): string {
  switch (goalType) {
    case GoalTypeEnum.SAVE:
      return "The user's stated goal is general saving — they have not set a specific numeric target. Frame the report around how much room their spending leaves for saving: contrast discretionary spend against income, and suggest what redirecting some of it toward savings could look like. Do not invent a savings target or pace — none exists.";
    case GoalTypeEnum.DEBT:
      return "The user's stated goal is paying down debt. Frame discretionary spend as directly competing with debt payoff — money not spent on non-essentials is money that could go toward the debt instead. Stay warm and non-judgmental, but be direct about that tradeoff.";
    case GoalTypeEnum.DAILY:
      return "The user's stated goal is day-to-day cash-flow management — there is no savings or debt target to pace against. Frame the report around pacing spend across their pay cycle (see pay_frequency) toward the next payday, not around a long-term target.";
    case GoalTypeEnum.SPECIFIC:
      return 'The user has a specific goal with a real numeric target. Ground the report in the actual pace math already computed for it (required_monthly_pace / required_weekly_pace in the goals array) and name the goal explicitly by name.';
    default:
      return 'The user has not set a specific financial goal yet. Keep the report focused on their spend and income patterns without assuming a goal — do not invent one.';
  }
}

// Shared between weekly and monthly: per-goal pace math, now including a
// weekly pace alongside the existing monthly one.
function buildGoalsContext(goals: IGoal[], now: Date) {
  return goals.map((g) => {
    const monthsRemaining = g.targetDate ? Math.max(1, monthsBetween(now, g.targetDate)) : null;
    const requiredMonthlyPace = g.targetAmount != null && monthsRemaining
      ? (g.targetAmount - g.savedAmount) / monthsRemaining
      : null;
    const requiredWeeklyPace = requiredMonthlyPace != null ? requiredMonthlyPace / 4.345 : null;

    return {
      name: g.name,
      type: g.type,
      target: g.targetAmount,
      saved: g.savedAmount,
      months_remaining: monthsRemaining,
      required_monthly_pace: requiredMonthlyPace,
      required_weekly_pace: requiredWeeklyPace,
    };
  });
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

    const merchantTotals = debits.reduce((acc: Record<string, number>, t) => {
      const name = t.merchant || 'Unknown';
      acc[name] = (acc[name] || 0) + Math.abs(t.refAmount);
      return acc;
    }, {});

    const categoryTotals = debits.reduce((acc: Record<string, number>, t) => {
      acc[t.category] = (acc[t.category] || 0) + Math.abs(t.refAmount);
      return acc;
    }, {});

    const top_merchants = Object.entries(merchantTotals)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 15)
      .map(([merchant, total]) => ({ merchant, total }));

    const top_categories = Object.entries(categoryTotals)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([cat, total]) => ({ category: cat, total }));

    return { totalSpend, top_categories, top_merchants, categoryTotals, merchantTotals };
  }

  // Same chart both report paths build from their top categories, computed
  // deterministically from real numbers rather than asked of the model.
  private buildCategoryChart(topCategories: { category: string; total: number }[]): Chart | null {
    if (topCategories.length === 0) return null;
    return {
      type: 'bar_by_category',
      data: topCategories.slice(0, 7).map((c, i) => ({ label: c.category, value: c.total, highlight: i === 0 })),
    };
  }

  async canGenerateWeeklyReport(userId: number): Promise<boolean> {
    if (this.weeklyGenerationInProgress.has(userId)) return false;
    const { start: currentWeekStart } = getCurrentWeekBounds(new Date());
    const { start } = getPriorWeekBounds(currentWeekStart);
    const alreadyGenerated = await this.insightRepository.hasReportForPeriod(userId, 'weekly', start);
    return !alreadyGenerated;
  }

  async generateWeeklyReportForUser(userId: number): Promise<void> {
    this.weeklyGenerationInProgress.add(userId);
    try {
      const user = await this.userRepository.findById(userId);
      if (!user) return;

      const now = new Date();
      // The report always covers the most recently *concluded* Mon-Sun week,
      // never the in-progress one — a Monday-morning cron run would otherwise
      // report on a week that just started and has no data yet.
      const { start: currentWeekStart } = getCurrentWeekBounds(now);
      const { start: weekStart, end: weekEnd } = getPriorWeekBounds(currentWeekStart);
      const alreadyGenerated = await this.insightRepository.hasReportForPeriod(userId, 'weekly', weekStart);
      if (alreadyGenerated) {
        logger.info(`Skipping insight generation for user ${userId} — already have this week's report`);
        return;
      }

      const { start: priorWeekStart, end: priorWeekEnd } = getPriorWeekBounds(weekStart);

      const [transactions, priorWeekTransactions, goals] = await Promise.all([
        this.transactionRepository.findForSummary(userId, weekStart, weekEnd),
        this.transactionRepository.findForSummary(userId, priorWeekStart, priorWeekEnd),
        this.goalRepository.findAllByUser(userId),
      ]);

      const current = this.summarizeSpend(transactions);
      const prior = this.summarizeSpend(priorWeekTransactions);

      const spendChangePct = prior.totalSpend > 0
        ? Math.round(((current.totalSpend - prior.totalSpend) / prior.totalSpend) * 1000) / 10
        : null;

      const income = buildIncomeContext(user.incomeRange, transactions, 'weekly');
      const categoryDeltas = buildCategoryDeltas(current.categoryTotals, prior.categoryTotals, 8);
      const merchantDeltas = buildDeltas(current.merchantTotals, prior.merchantTotals, 8);
      const currentSplit = splitByClassification(current.categoryTotals);
      const priorSplit = splitByClassification(prior.categoryTotals);
      const flags = computeRedFlags(categoryDeltas, income.income_for_period);
      const goalsContext = buildGoalsContext(goals, now);

      const context = {
        period_total_spend: current.totalSpend,
        prior_period_total_spend: prior.totalSpend,
        spend_change_pct: spendChangePct,
        income,
        ref_currency: user.refCurrency,
        goal_type: user.goalType,
        advisor_tone: user.advisorTone,
        pay_frequency: user.payFrequency,
        goals: goalsContext,
        top_categories: current.top_categories,
        top_merchants: current.top_merchants,
        category_deltas: categoryDeltas,
        merchant_deltas: merchantDeltas,
        essential_spend: { this_period: currentSplit.essential, prior_period: priorSplit.essential },
        discretionary_spend: { this_period: currentSplit.discretionary, prior_period: priorSplit.discretionary },
        neutral_spend: { this_period: currentSplit.neutral, prior_period: priorSplit.neutral },
        flags,
      };

      const response = await this.openai.chat.completions.create({
        model: CONSTANTS.OPENAI_MODEL_INSIGHT,
        messages: [
          {
            role: 'system',
            content: `You are Iris, a warm and non-judgmental personal financial advisor. This app exists to help the user build real financial freedom — your job is to read their actual spending and income for this week and write ONE concise, specific report, not a list of generic observations. It should read in about fifteen seconds, not like a document. You never shame. You always frame observations as opportunities.

${goalFramingInstructions(user.goalType)}

The user's preferred tone is ${user.advisorTone}.

income.income_source tells you how solid the income figure is: "actual" means it's computed from real categorized salary/wages deposits this week — safe to state percent-of-income claims confidently. "estimated" means it's the onboarding income-bucket midpoint divided into a weekly figure — hedge slightly ("roughly", "about"). "unknown" means there's no usable income figure at all — do not make any percent-of-income claim.

category_deltas and merchant_deltas compare this week against last week for every category/merchant that appeared in either period, not just whichever is biggest in absolute terms — each row has a trend: "up"/"down" (5%+ change), "flat", "new" (nothing last week, something this week), or "stopped" (something last week, nothing this week). A smaller category that spiked or a merchant that appeared for the first time is often the more interesting story — do not limit yourself to the single top category.

flags are categories already flagged programmatically as discretionary, trending up, and eating a meaningful share of income — treat these as strong candidates for your headline or a finding, but explain them in your own words rather than repeating the numbers verbatim.

essential_spend / discretionary_spend / neutral_spend split this week's and last week's spend into needs (essential), wants (discretionary), and neutral (transfers, savings, income-adjacent) — use this for needs-vs-wants framing when relevant.

Use top_merchants (real merchant names like Glovo, Netflix, Cloudflare, etc.) to name specific merchants when relevant, even when the category is "other".

Be selective. Pick the 2-3 sharpest, most specific findings in the data.

Return a JSON object: { "report": { ...report object... } }

The report object must have:
- "headline": ONE punchy sentence capturing the single most important thing this week, grounded in a real number or trend. Max 15 words.
- "findings": array of 2-3 short, specific, quantified findings (strings), each 1-2 sentences — favor deltas and flags over a flat restatement of the biggest category.
- "closing": 1-2 sentence closing paragraph that follows the goal-framing guidance above and references the user's real goals (the "goals" array — name a goal by name when relevant). If "goals" is empty, gently note that setting one would help, without being pushy.
- "goal_alignment": { "status": one of "on_track" | "ahead" | "behind" | "no_goals", "delta_amount": a number in ${user.refCurrency} estimating how far off pace this week's spending puts the user (positive if behind, negative or 0 if ahead/on track; null if no_goals), "summary": one sentence explaining the status, naming a specific goal and the delta_amount when possible }

Charts are generated separately — do not return chart_type or chart_data.

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
        closing?: string;
        goal_alignment?: { status?: string; delta_amount?: number | null; summary?: string };
      } = raw.report || raw;

      if (!report.headline) {
        logger.warn(`Insight generation for user ${userId} returned no headline — skipping`);
        await this.insightRepository.deleteExpired(userId);
        return;
      }

      const expiry = new Date();
      expiry.setDate(expiry.getDate() + 7);

      const categoryChart = this.buildCategoryChart(current.top_categories);
      const charts: Chart[] = categoryChart ? [categoryChart] : [];

      await this.insightRepository.create({
        userId,
        type: InsightTypeEnum.REPORT,
        message: report.headline,
        contextData: {
          headline: report.headline,
          findings: report.findings ?? [],
          chart_type: categoryChart?.type ?? null,
          chart_data: categoryChart?.data ?? null,
          charts,
          closing: report.closing ?? null,
          goal_alignment: {
            status: report.goal_alignment?.status ?? 'on_track',
            delta_amount: report.goal_alignment?.delta_amount ?? null,
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

      const current = this.summarizeSpend(transactions);
      const prior = this.summarizeSpend(priorMonthTransactions);

      const spendChangePct = prior.totalSpend > 0
        ? Math.round(((current.totalSpend - prior.totalSpend) / prior.totalSpend) * 1000) / 10
        : null;

      const income = buildIncomeContext(user.incomeRange, transactions, 'monthly');
      const categoryDeltas = buildCategoryDeltas(current.categoryTotals, prior.categoryTotals, 8);
      const merchantDeltas = buildDeltas(current.merchantTotals, prior.merchantTotals, 8);
      const currentSplit = splitByClassification(current.categoryTotals);
      const priorSplit = splitByClassification(prior.categoryTotals);
      const flags = computeRedFlags(categoryDeltas, income.income_for_period);
      const goalsContext = buildGoalsContext(goals, now);

      const context = {
        period_total_spend: current.totalSpend,
        prior_period_total_spend: prior.totalSpend,
        spend_change_pct: spendChangePct,
        income,
        ref_currency: user.refCurrency,
        goal_type: user.goalType,
        advisor_tone: user.advisorTone,
        pay_frequency: user.payFrequency,
        goals: goalsContext,
        top_categories: current.top_categories,
        top_merchants: current.top_merchants,
        prior_period_top_categories: prior.top_categories,
        category_deltas: categoryDeltas,
        merchant_deltas: merchantDeltas,
        essential_spend: { this_period: currentSplit.essential, prior_period: priorSplit.essential },
        discretionary_spend: { this_period: currentSplit.discretionary, prior_period: priorSplit.discretionary },
        neutral_spend: { this_period: currentSplit.neutral, prior_period: priorSplit.neutral },
        flags,
      };

      const response = await this.openai.chat.completions.create({
        model: CONSTANTS.OPENAI_MODEL_INSIGHT,
        messages: [
          {
            role: 'system',
            content: `You are Iris, a warm and non-judgmental personal financial advisor. This app exists to help the user build real financial freedom — your job is to read a full month of their actual spending and income and write ONE concise monthly report — a narrative, not a document. It should still read in well under a minute. You never shame. You always frame observations as opportunities.

${goalFramingInstructions(user.goalType)}

The user's preferred tone is ${user.advisorTone}.

income.income_source tells you how solid the income figure is: "actual" means it's computed from real categorized salary/wages deposits this month — safe to state percent-of-income claims confidently. "estimated" means it's the onboarding income-bucket midpoint — hedge slightly ("roughly", "about"). "unknown" means there's no usable income figure at all — do not make any percent-of-income claim.

category_deltas and merchant_deltas compare this month against last month for every category/merchant that appeared in either period, not just whichever is biggest in absolute terms — each row has a trend: "up"/"down" (5%+ change), "flat", "new", or "stopped". Do not limit yourself to the single top category.

flags are categories already flagged programmatically as discretionary, trending up, and eating a meaningful share of income — treat these as strong candidates for a finding, explained in your own words.

essential_spend / discretionary_spend / neutral_spend split this month's and last month's spend into needs, wants, and neutral — use this for needs-vs-wants framing when relevant.

Use top_merchants (real merchant names like Glovo, Netflix, Cloudflare, etc.) to name specific merchants when relevant, even when the category is "other". Use prior_period_total_spend, prior_period_top_categories, and spend_change_pct to explicitly compare this month against last month — that comparison is the point of a monthly report.

Be selective. Pick the 2-3 sharpest, most specific findings — favor deltas and flags over a flat restatement of the biggest category.

Return a JSON object: { "report": { ...report object... } }

The report object must have:
- "headline": ONE punchy sentence capturing the single most important thing this month, ideally naming the trend vs last month. Max 15 words.
- "findings": array of 2-3 short, specific, quantified findings (strings), each 1-2 sentences, at least one of which references the month-over-month trend.
- "closing": 2-3 sentence closing narrative that follows the goal-framing guidance above and references the user's real goals (the "goals" array — name a goal by name when relevant, referencing required_monthly_pace where available). If "goals" is empty, gently note that setting one would help, without being pushy.
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
      const categoryChart = this.buildCategoryChart(current.top_categories);
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
            status: report.goal_alignment?.status ?? 'on_track',
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
