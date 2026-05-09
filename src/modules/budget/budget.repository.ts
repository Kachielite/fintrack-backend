import { inject, injectable } from 'tsyringe';
import { and, eq } from 'drizzle-orm';
import Database from '@/common/lib/database';
import { BudgetSchema } from './budget.schema';
import { IBudget, ICreateBudget } from './budget.interface';

export interface IBudgetRepository {
  create(data: ICreateBudget): Promise<IBudget>;
  findById(id: number, userId: number): Promise<IBudget | null>;
  findAllActive(userId: number): Promise<IBudget[]>;
  update(id: number, userId: number, data: Partial<IBudget>): Promise<IBudget>;
  deactivate(id: number, userId: number): Promise<void>;
}

@injectable()
class BudgetRepositoryImpl implements IBudgetRepository {
  constructor(@inject(Database) private db: Database) {}

  async create(data: ICreateBudget): Promise<IBudget> {
    const [row] = await this.db.client
      .insert(BudgetSchema)
      .values({
        userId: data.userId,
        category: data.category,
        limitAmount: data.limitAmount,
        currency: data.currency,
        periodType: data.periodType,
        isSuggestedByAi: data.isSuggestedByAi || false,
      })
      .returning();
    return row as IBudget;
  }

  async findById(id: number, userId: number): Promise<IBudget | null> {
    const rows = await this.db.client
      .select()
      .from(BudgetSchema)
      .where(and(eq(BudgetSchema.id, id), eq(BudgetSchema.userId, userId)))
      .limit(1);
    return (rows[0] as IBudget) ?? null;
  }

  async findAllActive(userId: number): Promise<IBudget[]> {
    return (await this.db.client
      .select()
      .from(BudgetSchema)
      .where(
        and(eq(BudgetSchema.userId, userId), eq(BudgetSchema.isActive, true)),
      )) as IBudget[];
  }

  async update(id: number, userId: number, data: Partial<IBudget>): Promise<IBudget> {
    const [row] = await this.db.client
      .update(BudgetSchema)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(BudgetSchema.id, id), eq(BudgetSchema.userId, userId)))
      .returning();
    return row as IBudget;
  }

  async deactivate(id: number, userId: number): Promise<void> {
    await this.db.client
      .update(BudgetSchema)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(BudgetSchema.id, id), eq(BudgetSchema.userId, userId)));
  }
}

export default BudgetRepositoryImpl;
