import { inject, injectable } from 'tsyringe';
import { eq } from 'drizzle-orm';
import Database from '@/common/lib/database';
import { UserSchema } from './user.schema';
import { IUser, ICreateUser, IUpdateUser, ICompleteOnboarding } from './user.interface';

export interface IUserRepository {
  createUser(data: ICreateUser): Promise<IUser>;
  findById(id: number): Promise<IUser | null>;
  findByEmail(email: string): Promise<IUser | null>;
  findAll(): Promise<IUser[]>;
  updateUser(id: number, data: Partial<IUpdateUser>): Promise<IUser>;
  completeOnboarding(id: number, data: ICompleteOnboarding): Promise<IUser>;
  updateRefreshTokenHash(id: number, hash: string | null): Promise<void>;
  deleteUser(id: number): Promise<void>;
}

@injectable()
class UserRepositoryImpl implements IUserRepository {
  constructor(@inject(Database) private db: Database) {}

  async createUser(data: ICreateUser): Promise<IUser> {
    const [row] = await this.db.client
      .insert(UserSchema)
      .values({ email: data.email, firstName: data.firstName, lastName: data.lastName })
      .returning();
    return row as IUser;
  }

  async findById(id: number): Promise<IUser | null> {
    const rows = await this.db.client
      .select()
      .from(UserSchema)
      .where(eq(UserSchema.id, id))
      .limit(1);
    return (rows[0] as IUser) ?? null;
  }

  async findAll(): Promise<IUser[]> {
    return (await this.db.client.select().from(UserSchema)) as IUser[];
  }

  async findByEmail(email: string): Promise<IUser | null> {
    const rows = await this.db.client
      .select()
      .from(UserSchema)
      .where(eq(UserSchema.email, email))
      .limit(1);
    return (rows[0] as IUser) ?? null;
  }

  async updateUser(id: number, data: Partial<IUpdateUser>): Promise<IUser> {
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (data.firstName !== undefined) updateData.firstName = data.firstName;
    if (data.lastName !== undefined) updateData.lastName = data.lastName;
    if (data.refCurrency !== undefined) updateData.refCurrency = data.refCurrency;
    if (data.advisorTone !== undefined) updateData.advisorTone = data.advisorTone;

    const [row] = await this.db.client
      .update(UserSchema)
      .set(updateData)
      .where(eq(UserSchema.id, id))
      .returning();
    return row as IUser;
  }

  async completeOnboarding(id: number, data: ICompleteOnboarding): Promise<IUser> {
    const [row] = await this.db.client
      .update(UserSchema)
      .set({
        goalType: data.goalType,
        incomeRange: data.incomeRange,
        payFrequency: data.payFrequency,
        refCurrency: data.refCurrency,
        onboardingComplete: true,
        updatedAt: new Date(),
      })
      .where(eq(UserSchema.id, id))
      .returning();
    return row as IUser;
  }

  async updateRefreshTokenHash(id: number, hash: string | null): Promise<void> {
    await this.db.client
      .update(UserSchema)
      .set({ refreshTokenHash: hash, updatedAt: new Date() })
      .where(eq(UserSchema.id, id));
  }

  async deleteUser(id: number): Promise<void> {
    await this.db.client.delete(UserSchema).where(eq(UserSchema.id, id));
  }
}

export default UserRepositoryImpl;
