import { inject, injectable } from 'tsyringe';
import { eq } from 'drizzle-orm';
import Database from '@/common/lib/database';
import { BankSchema } from './bank.schema';
import { IBank } from './bank.interface';

export interface IBankRepository {
  findAll(): Promise<IBank[]>;
  findById(id: number): Promise<IBank | null>;
  findBySenderEmail(email: string): Promise<IBank | null>;
}

@injectable()
class BankRepositoryImpl implements IBankRepository {
  constructor(@inject(Database) private db: Database) {}

  async findAll(): Promise<IBank[]> {
    return (await this.db.client
      .select()
      .from(BankSchema)
      .where(eq(BankSchema.isActive, true))) as IBank[];
  }

  async findById(id: number): Promise<IBank | null> {
    const rows = await this.db.client
      .select()
      .from(BankSchema)
      .where(eq(BankSchema.id, id))
      .limit(1);
    return (rows[0] as IBank) ?? null;
  }

  async findBySenderEmail(email: string): Promise<IBank | null> {
    const banks = await this.findAll();
    return banks.find((b) => b.knownSenderEmails.includes(email.toLowerCase())) ?? null;
  }
}

export default BankRepositoryImpl;
