import { inject, injectable } from 'tsyringe';
import { and, eq } from 'drizzle-orm';
import Database from '@/common/lib/database';
import { GoalSchema } from './goal.schema';
import { IGoal, ICreateGoal } from './goal.interface';

export interface IGoalRepository {
  create(data: ICreateGoal): Promise<IGoal>;
  findById(id: number, userId: number): Promise<IGoal | null>;
  findAllByUser(userId: number): Promise<IGoal[]>;
  update(id: number, userId: number, data: Partial<IGoal>): Promise<IGoal>;
  delete(id: number, userId: number): Promise<void>;
}

@injectable()
class GoalRepositoryImpl implements IGoalRepository {
  constructor(@inject(Database) private db: Database) {}

  async create(data: ICreateGoal): Promise<IGoal> {
    const [row] = await this.db.client
      .insert(GoalSchema)
      .values({
        userId: data.userId,
        name: data.name,
        type: data.type,
        targetAmount: data.targetAmount,
        currency: data.currency,
        targetDate: data.targetDate,
      })
      .returning();
    return row as IGoal;
  }

  async findById(id: number, userId: number): Promise<IGoal | null> {
    const rows = await this.db.client
      .select()
      .from(GoalSchema)
      .where(and(eq(GoalSchema.id, id), eq(GoalSchema.userId, userId)))
      .limit(1);
    return (rows[0] as IGoal) ?? null;
  }

  async findAllByUser(userId: number): Promise<IGoal[]> {
    return (await this.db.client
      .select()
      .from(GoalSchema)
      .where(and(eq(GoalSchema.userId, userId), eq(GoalSchema.isActive, true)))) as IGoal[];
  }

  async update(id: number, userId: number, data: Partial<IGoal>): Promise<IGoal> {
    const [row] = await this.db.client
      .update(GoalSchema)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(GoalSchema.id, id), eq(GoalSchema.userId, userId)))
      .returning();
    return row as IGoal;
  }

  async delete(id: number, userId: number): Promise<void> {
    await this.db.client
      .delete(GoalSchema)
      .where(and(eq(GoalSchema.id, id), eq(GoalSchema.userId, userId)));
  }
}

export default GoalRepositoryImpl;
