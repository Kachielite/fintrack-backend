import { inject, injectable } from 'tsyringe';
import { and, eq } from 'drizzle-orm';
import Database from '@/common/lib/database';
import { AuthProviderSchema } from './auth.schema';
import { IAuthProvider, ICreateAuthProvider, IFindAuthProvider } from './auth.interface';
import { AuthProviderEnum } from './auth.enum';

export interface IAuthRepository {
  createAuthProvider(data: ICreateAuthProvider): Promise<IAuthProvider>;
  findAuthProvider(data: IFindAuthProvider): Promise<IAuthProvider | null>;
}

@injectable()
class AuthRepositoryImpl implements IAuthRepository {
  constructor(@inject(Database) private db: Database) {}

  async createAuthProvider(data: ICreateAuthProvider): Promise<IAuthProvider> {
    const [row] = await this.db.client
      .insert(AuthProviderSchema)
      .values({
        userId: data.userId,
        provider: data.provider,
        providerUserId: data.providerUserId,
      })
      .returning();
    return row as IAuthProvider;
  }

  async findAuthProvider({ provider, providerUserId }: IFindAuthProvider): Promise<IAuthProvider | null> {
    const rows = await this.db.client
      .select()
      .from(AuthProviderSchema)
      .where(
        and(
          eq(AuthProviderSchema.provider, provider),
          eq(AuthProviderSchema.providerUserId, providerUserId),
        ),
      )
      .limit(1);
    return (rows[0] as IAuthProvider) ?? null;
  }
}

export default AuthRepositoryImpl;
