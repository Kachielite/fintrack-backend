import { inject, injectable } from 'tsyringe';
import { eq } from 'drizzle-orm';
import Database from '@/common/lib/database';
import { BankSchema } from './bank.schema';
import { IBank } from './bank.interface';

export interface IBankRepository {
  findAll(): Promise<IBank[]>;
  findById(id: number): Promise<IBank | null>;
  findBySenderEmail(email: string): Promise<IBank | null>;
  upsertByShortCode(data: {
    name: string;
    shortCode: string;
    country?: string;
    senderEmail: string;
  }): Promise<IBank>;
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

  async upsertByShortCode(data: {
    name: string;
    shortCode: string;
    country?: string;
    senderEmail: string;
  }): Promise<IBank> {
    const existing = await this.db.client
      .select()
      .from(BankSchema)
      .where(eq(BankSchema.shortCode, data.shortCode))
      .limit(1);

    if (existing.length > 0) {
      const bank = existing[0] as IBank;
      if (bank.knownSenderEmails.includes(data.senderEmail)) return bank;
      const updated = await this.db.client
        .update(BankSchema)
        .set({ knownSenderEmails: [...bank.knownSenderEmails, data.senderEmail] })
        .where(eq(BankSchema.shortCode, data.shortCode))
        .returning();
      return updated[0] as IBank;
    }

    const created = await this.db.client
      .insert(BankSchema)
      .values({
        name: data.name,
        shortCode: data.shortCode,
        country: data.country ?? null,
        knownSenderEmails: [data.senderEmail],
      })
      .returning();
    return created[0] as IBank;
  }
}

export default BankRepositoryImpl;
