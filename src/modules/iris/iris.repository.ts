import { inject, injectable } from 'tsyringe';
import { and, desc, eq, sql } from 'drizzle-orm';
import Database from '@/common/lib/database';
import { IrisSessionSchema, IrisMessageSchema, IrisEmbeddingSchema } from './iris.schema';
import { IIrisSession, IIrisMessage, IChartData } from './iris.interface';

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

export interface IIrisRepository {
  createSession(userId: number, title?: string): Promise<IIrisSession>;
  findSessions(userId: number): Promise<IIrisSession[]>;
  findSession(id: number, userId: number): Promise<IIrisSession | null>;
  deleteSession(id: number, userId: number): Promise<void>;
  updateSessionTitle(id: number, title: string): Promise<void>;
  createMessage(data: {
    sessionId: number;
    role: string;
    content: string;
    chartData?: IChartData | null;
  }): Promise<IIrisMessage>;
  findMessages(sessionId: number): Promise<IIrisMessage[]>;
  findRecentMessages(sessionId: number, limit: number): Promise<IIrisMessage[]>;
  countMessages(sessionId: number): Promise<number>;
  upsertEmbedding(data: {
    userId: number;
    chunkType: string;
    period: string;
    content: string;
    embedding: number[];
  }): Promise<void>;
  hasEmbeddings(userId: number): Promise<boolean>;
  findSimilarChunks(
    userId: number,
    embedding: number[],
    limit: number,
  ): Promise<Array<{ content: string; similarity: number }>>;
  deleteEmbeddingsForUser(userId: number): Promise<void>;
}

@injectable()
class IrisRepositoryImpl implements IIrisRepository {
  constructor(@inject(Database) private db: Database) {}

  async createSession(userId: number, title?: string): Promise<IIrisSession> {
    const [row] = await this.db.client
      .insert(IrisSessionSchema)
      .values({ userId, title: title ?? null })
      .returning();
    return row as IIrisSession;
  }

  async findSessions(userId: number): Promise<IIrisSession[]> {
    return (await this.db.client
      .select()
      .from(IrisSessionSchema)
      .where(eq(IrisSessionSchema.userId, userId))
      .orderBy(desc(IrisSessionSchema.updatedAt))) as IIrisSession[];
  }

  async findSession(id: number, userId: number): Promise<IIrisSession | null> {
    const rows = await this.db.client
      .select()
      .from(IrisSessionSchema)
      .where(and(eq(IrisSessionSchema.id, id), eq(IrisSessionSchema.userId, userId)))
      .limit(1);
    return rows.length > 0 ? (rows[0] as IIrisSession) : null;
  }

  async deleteSession(id: number, userId: number): Promise<void> {
    await this.db.client
      .delete(IrisSessionSchema)
      .where(and(eq(IrisSessionSchema.id, id), eq(IrisSessionSchema.userId, userId)));
  }

  async updateSessionTitle(id: number, title: string): Promise<void> {
    await this.db.client
      .update(IrisSessionSchema)
      .set({ title, updatedAt: new Date() })
      .where(eq(IrisSessionSchema.id, id));
  }

  async createMessage(data: {
    sessionId: number;
    role: string;
    content: string;
    chartData?: IChartData | null;
  }): Promise<IIrisMessage> {
    const [row] = await this.db.client
      .insert(IrisMessageSchema)
      .values({
        sessionId: data.sessionId,
        role: data.role,
        content: data.content,
        chartData: (data.chartData ?? null) as any,
      })
      .returning();
    return row as IIrisMessage;
  }

  async findMessages(sessionId: number): Promise<IIrisMessage[]> {
    return (await this.db.client
      .select()
      .from(IrisMessageSchema)
      .where(eq(IrisMessageSchema.sessionId, sessionId))
      .orderBy(IrisMessageSchema.createdAt)) as IIrisMessage[];
  }

  async findRecentMessages(sessionId: number, limit: number): Promise<IIrisMessage[]> {
    const rows = await this.db.client
      .select()
      .from(IrisMessageSchema)
      .where(eq(IrisMessageSchema.sessionId, sessionId))
      .orderBy(desc(IrisMessageSchema.createdAt))
      .limit(limit);
    return rows.reverse() as IIrisMessage[];
  }

  async countMessages(sessionId: number): Promise<number> {
    const rows = await this.db.client
      .select({ count: sql<number>`count(*)` })
      .from(IrisMessageSchema)
      .where(eq(IrisMessageSchema.sessionId, sessionId));
    return Number(rows[0]?.count ?? 0);
  }

  async upsertEmbedding(data: {
    userId: number;
    chunkType: string;
    period: string;
    content: string;
    embedding: number[];
  }): Promise<void> {
    // Raw sql`` interpolates a JS array as multiple parenthesized params
    // (e.g. for IN-clauses), not a Postgres array literal, which made this
    // fail against the real[] column. The query builder serializes it
    // correctly via the column's own type handler.
    await this.db.client
      .insert(IrisEmbeddingSchema)
      .values({
        userId: data.userId,
        chunkType: data.chunkType,
        period: data.period,
        content: data.content,
        embedding: data.embedding,
      })
      .onConflictDoUpdate({
        target: [IrisEmbeddingSchema.userId, IrisEmbeddingSchema.chunkType, IrisEmbeddingSchema.period],
        set: { content: data.content, embedding: data.embedding, updatedAt: new Date() },
      });
  }

  async hasEmbeddings(userId: number): Promise<boolean> {
    const rows = await this.db.client
      .select({ id: IrisEmbeddingSchema.id })
      .from(IrisEmbeddingSchema)
      .where(eq(IrisEmbeddingSchema.userId, userId))
      .limit(1);
    return rows.length > 0;
  }

  async findSimilarChunks(
    userId: number,
    queryEmbedding: number[],
    limit: number,
  ): Promise<Array<{ content: string; similarity: number }>> {
    // Fetch all embeddings for this user and rank by cosine similarity in process.
    // With 4–5 chunks per user this is negligible overhead vs. pgvector.
    const rows = await this.db.client
      .select({
        content: IrisEmbeddingSchema.content,
        embedding: IrisEmbeddingSchema.embedding,
      })
      .from(IrisEmbeddingSchema)
      .where(eq(IrisEmbeddingSchema.userId, userId));

    return rows
      .map((r) => ({
        content: r.content,
        similarity: cosineSimilarity(queryEmbedding, (r.embedding as unknown as number[]) ?? []),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  async deleteEmbeddingsForUser(userId: number): Promise<void> {
    await this.db.client
      .delete(IrisEmbeddingSchema)
      .where(eq(IrisEmbeddingSchema.userId, userId));
  }
}

export default IrisRepositoryImpl;
