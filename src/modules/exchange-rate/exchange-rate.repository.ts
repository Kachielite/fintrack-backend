import { inject, injectable } from 'tsyringe';
import { and, eq, max } from 'drizzle-orm';
import Database from '@/common/lib/database';
import { ExchangeRateSchema } from './exchange-rate.schema';
import { IExchangeRate } from './exchange-rate.interface';

export interface IExchangeRateRepository {
  findAll(): Promise<IExchangeRate[]>;
  findRate(baseCurrency: string, targetCurrency: string): Promise<IExchangeRate | null>;
  findLatestFetch(): Promise<Date | null>;
  bulkInsert(rates: Pick<IExchangeRate, 'baseCurrency' | 'targetCurrency' | 'rate' | 'fetchedAt'>[]): Promise<void>;
  updateRateById(id: number, rate: number, fetchedAt: Date): Promise<void>;
}

@injectable()
class ExchangeRateRepositoryImpl implements IExchangeRateRepository {
  constructor(@inject(Database) private db: Database) {}

  async findAll(): Promise<IExchangeRate[]> {
    return (await this.db.client.select().from(ExchangeRateSchema)) as IExchangeRate[];
  }

  async findRate(baseCurrency: string, targetCurrency: string): Promise<IExchangeRate | null> {
    const rows = await this.db.client
      .select()
      .from(ExchangeRateSchema)
      .where(
        and(
          eq(ExchangeRateSchema.baseCurrency, baseCurrency),
          eq(ExchangeRateSchema.targetCurrency, targetCurrency),
        ),
      )
      .limit(1);
    return (rows[0] as IExchangeRate) ?? null;
  }

  async findLatestFetch(): Promise<Date | null> {
    const [row] = await this.db.client
      .select({ latest: max(ExchangeRateSchema.fetchedAt) })
      .from(ExchangeRateSchema);
    return row?.latest ?? null;
  }

  async bulkInsert(
    rates: Pick<IExchangeRate, 'baseCurrency' | 'targetCurrency' | 'rate' | 'fetchedAt'>[],
  ): Promise<void> {
    if (rates.length === 0) return;
    await this.db.client.insert(ExchangeRateSchema).values(rates);
  }

  async updateRateById(id: number, rate: number, fetchedAt: Date): Promise<void> {
    await this.db.client
      .update(ExchangeRateSchema)
      .set({ rate, fetchedAt })
      .where(eq(ExchangeRateSchema.id, id));
  }
}

export default ExchangeRateRepositoryImpl;
