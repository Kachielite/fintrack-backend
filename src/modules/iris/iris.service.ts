import { inject, injectable } from 'tsyringe';
import OpenAI from 'openai';
import { CONSTANTS } from '@/common/configuration/constants';
import logger from '@/common/lib/logger';
import { IIrisRepository } from './iris.repository';
import { IIrisSession, IIrisMessage } from './iris.interface';
import { SendMessageDTO } from './iris.dto';
import { IrisMessageRoleEnum } from './iris.enum';
import { IUserRepository } from '@/modules/user/user.repository';
import { ITransactionRepository } from '@/modules/transaction/transaction.repository';
import { IBudgetRepository } from '@/modules/budget/budget.repository';
import { IGoalRepository } from '@/modules/goal/goal.repository';
import { buildSystemPrompt } from './prompt/system-prompt';
import { parseTimeFrame } from './time-frame';
import { ResourceNotFoundException, InternalServerException } from '@/common/exception';

export interface IIrisService {
  getStatus(userId: number): Promise<{ ready: boolean }>;
  initialize(userId: number): Promise<void>;
  createSession(userId: number): Promise<IIrisSession>;
  listSessions(userId: number): Promise<IIrisSession[]>;
  deleteSession(id: number, userId: number): Promise<void>;
  getMessages(sessionId: number, userId: number): Promise<IIrisMessage[]>;
  sendMessage(sessionId: number, userId: number, dto: SendMessageDTO): Promise<IIrisMessage>;
  getSuggestions(userId: number): Promise<string[]>;
}

const FALLBACK_SUGGESTIONS = [
  'How much did I spend this month?',
  'Which category do I overspend in?',
  'How are my budgets doing?',
  'Am I on track with my goals?',
];

@injectable()
class IrisService implements IIrisService {
  private openai: OpenAI;

  constructor(
    @inject('IIrisRepository') private irisRepository: IIrisRepository,
    @inject('IUserRepository') private userRepository: IUserRepository,
    @inject('ITransactionRepository') private transactionRepository: ITransactionRepository,
    @inject('IBudgetRepository') private budgetRepository: IBudgetRepository,
    @inject('IGoalRepository') private goalRepository: IGoalRepository,
  ) {
    this.openai = new OpenAI({ apiKey: CONSTANTS.OPENAI_API_KEY });
  }

  // Data is always available on demand — no embedding build required
  async getStatus(_userId: number): Promise<{ ready: boolean }> {
    return { ready: true };
  }

  async initialize(_userId: number): Promise<void> {
    // No-op: v1 queries data live, no embedding pipeline
  }

  async createSession(userId: number): Promise<IIrisSession> {
    return await this.irisRepository.createSession(userId);
  }

  async listSessions(userId: number): Promise<IIrisSession[]> {
    return await this.irisRepository.findSessions(userId);
  }

  async deleteSession(id: number, userId: number): Promise<void> {
    const session = await this.irisRepository.findSession(id, userId);
    if (!session) throw new ResourceNotFoundException('Session not found');
    await this.irisRepository.deleteSession(id, userId);
  }

  async getMessages(sessionId: number, userId: number): Promise<IIrisMessage[]> {
    const session = await this.irisRepository.findSession(sessionId, userId);
    if (!session) throw new ResourceNotFoundException('Session not found');
    return await this.irisRepository.findMessages(sessionId);
  }

  async sendMessage(sessionId: number, userId: number, dto: SendMessageDTO): Promise<IIrisMessage> {
    const [session, user] = await Promise.all([
      this.irisRepository.findSession(sessionId, userId),
      this.userRepository.findById(userId),
    ]);
    if (!session) throw new ResourceNotFoundException('Session not found');
    if (!user) throw new InternalServerException('User not found');

    await this.irisRepository.createMessage({
      sessionId,
      role: IrisMessageRoleEnum.USER,
      content: dto.content,
    });

    if (!session.title) {
      const count = await this.irisRepository.countMessages(sessionId);
      if (count <= 1) {
        await this.irisRepository.updateSessionTitle(sessionId, dto.content.slice(0, 60));
      }
    }

    const timeFrame = parseTimeFrame(dto.content);

    const [history, retrievedContext] = await Promise.all([
      this.irisRepository.findRecentMessages(sessionId, CONSTANTS.IRIS_MAX_CONTEXT_MESSAGES),
      this.buildLiveContext(userId, timeFrame).catch(() => ''),
    ]);

    const systemPrompt = buildSystemPrompt({
      advisorTone: user.advisorTone,
      goalType: user.goalType,
      refCurrency: user.refCurrency,
      retrievedContext,
    });

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...history.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    ];

    let content = "I'm sorry, I couldn't process that. Please try again.";
    let chartData = null;

    try {
      const response = await this.openai.chat.completions.create({
        model: CONSTANTS.OPENAI_MODEL,
        messages,
        response_format: { type: 'json_object' },
        max_tokens: 1000,
      });
      const raw = JSON.parse(response.choices[0].message.content ?? '{}');
      content = typeof raw.content === 'string' ? raw.content : content;
      chartData = raw.chartData ?? null;
    } catch (error) {
      logger.error(`Iris GPT call failed for session ${sessionId} - ${error}`);
    }

    return await this.irisRepository.createMessage({
      sessionId,
      role: IrisMessageRoleEnum.ASSISTANT,
      content,
      chartData,
    });
  }

  // Returns static chips for now; can be personalised later
  async getSuggestions(_userId: number): Promise<string[]> {
    return FALLBACK_SUGGESTIONS;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async buildLiveContext(userId: number, timeFrame: { start: Date; end: Date; label: string }): Promise<string> {
    const { start, end, label } = timeFrame;
    const now = new Date();
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // Expand to at least current month so budget status always has data
    const fetchStart = start < currentMonthStart ? start : currentMonthStart;

    const [txns, budgets, goals] = await Promise.all([
      this.transactionRepository.findForSummary(userId, fetchStart, end),
      this.budgetRepository.findAllActive(userId),
      this.goalRepository.findAllByUser(userId),
    ]);

    const currency = txns[0]?.refCurrency ?? 'NGN';
    const parts: string[] = [`Data range: ${label}`];

    // Transactions within the requested window
    const rangedTxns = txns.filter((t) => {
      const d = new Date(t.transactionDate);
      return d >= start && d <= end;
    });

    const debits = rangedTxns.filter((t) => t.amount < 0);
    const credits = rangedTxns.filter((t) => t.amount > 0);
    const totalSpend = debits.reduce((s, t) => s + Math.abs(t.refAmount), 0);
    const totalIncome = credits.reduce((s, t) => s + Math.abs(t.refAmount), 0);

    // Spending summary
    const categoryMap = debits.reduce<Record<string, number>>((acc, t) => {
      acc[t.category] = (acc[t.category] ?? 0) + Math.abs(t.refAmount);
      return acc;
    }, {});
    const topCategories = Object.entries(categoryMap)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([cat, total]) => `${cat}: ${total.toFixed(2)}`)
      .join(', ');
    parts.push(
      `Spending for ${label}: ${totalSpend.toFixed(2)} ${currency} across ${debits.length} transactions.` +
        (topCategories ? ` Top categories: ${topCategories}.` : ''),
    );

    if (totalIncome > 0) {
      parts.push(`Income for ${label}: ${totalIncome.toFixed(2)} ${currency} across ${credits.length} transactions.`);
    }

    // Top merchants
    const merchantMap = debits.reduce<Record<string, number>>((acc, t) => {
      const name = t.merchant || 'Unknown';
      acc[name] = (acc[name] ?? 0) + Math.abs(t.refAmount);
      return acc;
    }, {});
    const topMerchants = Object.entries(merchantMap)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 15)
      .map(([m, total]) => `${m}: ${total.toFixed(2)} ${currency}`)
      .join('; ');
    if (topMerchants) parts.push(`Top merchants for ${label}: ${topMerchants}.`);

    // Monthly breakdown when range spans multiple months
    if (debits.length > 0) {
      const monthSet = new Set(debits.map((t) => {
        const d = new Date(t.transactionDate);
        return `${d.getFullYear()}-${d.getMonth()}`;
      }));
      if (monthSet.size > 1) {
        const monthlyLines: string[] = [];
        monthSet.forEach((key) => {
          const [yr, mo] = key.split('-').map(Number);
          const mStart = new Date(yr, mo, 1);
          const mEnd = new Date(yr, mo + 1, 0, 23, 59, 59);
          const mDebits = debits.filter((t) => {
            const d = new Date(t.transactionDate);
            return d >= mStart && d <= mEnd;
          });
          const mTotal = mDebits.reduce((s, t) => s + Math.abs(t.refAmount), 0);
          if (mTotal > 0) {
            const mLabel = mStart.toLocaleString('en', { month: 'long', year: 'numeric' });
            monthlyLines.push(`${mLabel}: ${mTotal.toFixed(2)} ${currency} (${mDebits.length} txns)`);
          }
        });
        if (monthlyLines.length > 0) {
          parts.push(`Monthly breakdown: ${monthlyLines.join('; ')}.`);
        }
      }
    }

    // Budget status — always current month
    if (budgets.length > 0) {
      const currentDebits = txns.filter((t) => {
        const d = new Date(t.transactionDate);
        return t.amount < 0 && d >= currentMonthStart;
      });
      const budgetLines = budgets.map((b) => {
        const spent = currentDebits
          .filter((t) => t.category === b.category)
          .reduce((s, t) => s + Math.abs(t.refAmount), 0);
        const pct = b.limitAmount > 0 ? ((spent / b.limitAmount) * 100).toFixed(0) : '0';
        return `${b.category}: ${spent.toFixed(2)} / ${b.limitAmount} ${currency} (${pct}% used)`;
      });
      parts.push(`Budget status this month: ${budgetLines.join('; ')}.`);
    }

    // Goals
    if (goals.length > 0) {
      const goalLines = goals.map((g) => {
        const target = g.targetAmount ?? 0;
        const pct = target > 0 ? ((g.savedAmount / target) * 100).toFixed(0) : '0';
        return `${g.name} (${g.type}): ${g.savedAmount.toFixed(2)} / ${target} ${currency} (${pct}% saved)`;
      });
      parts.push(`Financial goals: ${goalLines.join('; ')}.`);
    }

    return parts.join('\n');
  }
}

export default IrisService;
