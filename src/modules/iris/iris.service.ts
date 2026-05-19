import { inject, injectable } from 'tsyringe';
import OpenAI from 'openai';
import { CONSTANTS } from '@/common/configuration/constants';
import logger from '@/common/lib/logger';
import { IIrisRepository } from './iris.repository';
import { IIrisSession, IIrisMessage } from './iris.interface';
import { SendMessageDTO } from './iris.dto';
import { IrisMessageRoleEnum } from './iris.enum';
import { IUserRepository } from '@/modules/user/user.repository';
import { buildSystemPrompt } from './prompt/system-prompt';
import { buildSuggestionPrompt } from './prompt/suggestion-prompt';
import EmbeddingService, { IEmbeddingService } from './embedding/embedding.service';
import RetrievalService, { IRetrievalService } from './retrieval/retrieval.service';
import { ResourceNotFoundException, InternalServerException } from '@/common/exception';

export interface IIrisService {
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
    @inject(EmbeddingService) private embeddingService: IEmbeddingService,
    @inject(RetrievalService) private retrievalService: IRetrievalService,
  ) {
    this.openai = new OpenAI({ apiKey: CONSTANTS.OPENAI_API_KEY });
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

    // Persist user message
    await this.irisRepository.createMessage({
      sessionId,
      role: IrisMessageRoleEnum.USER,
      content: dto.content,
    });

    // Auto-title the session from the first message
    if (!session.title) {
      const count = await this.irisRepository.countMessages(sessionId);
      if (count <= 1) {
        await this.irisRepository.updateSessionTitle(sessionId, dto.content.slice(0, 60));
      }
    }

    // Build embeddings on first message if they don't exist yet
    const hasData = await this.irisRepository.hasEmbeddings(userId);
    if (!hasData) {
      await this.embeddingService.rebuildForUser(userId);
    }

    // Parallel: fetch conversation history + retrieve relevant context
    const [history, retrievedContext] = await Promise.all([
      this.irisRepository.findRecentMessages(sessionId, CONSTANTS.IRIS_MAX_CONTEXT_MESSAGES),
      this.retrievalService.retrieveContext(userId, dto.content).catch(() => ''),
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

  async getSuggestions(userId: number): Promise<string[]> {
    try {
      const probeEmbedding = await this.embeddingService
        .embed('spending budget goals merchants')
        .catch(() => [] as number[]);

      if (probeEmbedding.length === 0) return FALLBACK_SUGGESTIONS;

      const chunks = await this.irisRepository
        .findSimilarChunks(userId, probeEmbedding, 4)
        .catch(() => []);

      const snapshot = chunks.map((c) => c.content).join('\n');
      if (!snapshot) return FALLBACK_SUGGESTIONS;

      const prompt = buildSuggestionPrompt(snapshot);
      const response = await this.openai.chat.completions.create({
        model: CONSTANTS.OPENAI_MODEL_INSIGHT,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        max_tokens: 200,
      });
      const raw = JSON.parse(response.choices[0].message.content ?? '{}');
      return Array.isArray(raw.suggestions) ? raw.suggestions.slice(0, 4) : FALLBACK_SUGGESTIONS;
    } catch {
      return FALLBACK_SUGGESTIONS;
    }
  }
}

export default IrisService;
