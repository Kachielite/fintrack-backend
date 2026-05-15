import { inject, injectable } from 'tsyringe';
import { eq } from 'drizzle-orm';
import Database from '@/common/lib/database';
import { BankSchema } from './bank.schema';
import { IBank } from './bank.interface';
import { BankMatch, matchBank, normalizeEmail, extractDomain } from './bank-matching';

// Re-export so callers import from one place.
export type { DetectionSource, BankMatch } from './bank-matching';

export interface IBankRepository {
  findAll(): Promise<IBank[]>;
  findById(id: number): Promise<IBank | null>;
  /**
   * Returns the matched bank and the detection source so the caller can emit
   * structured logs without duplicating matching logic.
   */
  findBySenderEmail(email: string): Promise<BankMatch | null>;
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

  async findBySenderEmail(email: string): Promise<BankMatch | null> {
    const banks = await this.findAll();
    return matchBank(banks, email);
  }

  async upsertByShortCode(data: {
    name: string;
    shortCode: string;
    country?: string;
    senderEmail: string;
  }): Promise<IBank> {
    const normalizedEmail = normalizeEmail(data.senderEmail);
    const senderDomain = extractDomain(normalizedEmail);

    const existing = await this.db.client
      .select()
      .from(BankSchema)
      .where(eq(BankSchema.shortCode, data.shortCode))
      .limit(1);

    if (existing.length > 0) {
      const bank = existing[0] as IBank;

      const emailsToSet = bank.knownSenderEmails.includes(normalizedEmail)
        ? bank.knownSenderEmails
        : [...bank.knownSenderEmails, normalizedEmail];

      const domainsToSet =
        senderDomain && !bank.knownSenderDomains.includes(senderDomain)
          ? [...bank.knownSenderDomains, senderDomain]
          : bank.knownSenderDomains;

      // Skip DB write when nothing changed.
      if (emailsToSet === bank.knownSenderEmails && domainsToSet === bank.knownSenderDomains) {
        return bank;
      }

      const updated = await this.db.client
        .update(BankSchema)
        .set({ knownSenderEmails: emailsToSet, knownSenderDomains: domainsToSet })
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
        knownSenderEmails: [normalizedEmail],
        knownSenderDomains: senderDomain ? [senderDomain] : [],
      })
      .returning();
    return created[0] as IBank;
  }
}

export default BankRepositoryImpl;
