import { inject, injectable } from 'tsyringe';
import { CONSTANTS } from '@/common/configuration/constants';
import logger from '@/common/lib/logger';
import { IExchangeRateRepository } from './exchange-rate.repository';
import { ExchangeRateResponseDTO } from './exchange-rate.dto';
import { InternalServerException } from '@/common/exception';

const OPEN_EXCHANGE_BASE_URL = 'https://openexchangerates.org/api/latest.json';

export interface IExchangeRateService {
  fetchAndRefresh(): Promise<void>;
  getLatestRates(refCurrency: string): Promise<ExchangeRateResponseDTO[]>;
  convert(amount: number, fromCurrency: string, toCurrency: string): Promise<number>;
  getRate(fromCurrency: string, toCurrency: string): Promise<number>;
}

@injectable()
class ExchangeRateService implements IExchangeRateService {
  constructor(
    @inject('IExchangeRateRepository') private repository: IExchangeRateRepository,
  ) {}

  async fetchAndRefresh(): Promise<void> {
    try {
      // Free tier: max 3 calls/day — skip if fetched within the last 7 hours.
      // If this query throws, the table doesn't exist yet — abort and tell the user.
      let latestFetch: Date | null;
      try {
        latestFetch = await this.repository.findLatestFetch();
      } catch {
        logger.warn('Exchange rates table not ready — run "npm run db:push" to create tables.');
        return;
      }

      if (latestFetch) {
        const sevenHoursMs = 7 * 60 * 60 * 1000;
        if (Date.now() - new Date(latestFetch).getTime() < sevenHoursMs) {
          logger.info('Exchange rates are recent — skipping refresh.');
          return;
        }
      }

      const url = `${OPEN_EXCHANGE_BASE_URL}?app_id=${CONSTANTS.OPEN_EXCHANGE_RATES_APP_ID}&base=USD`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Open Exchange Rates API error: ${resp.status}`);
      const data = (await resp.json()) as { rates: Record<string, number> };

      // Pre-load existing rows to avoid ON CONFLICT dependency on a unique index
      const existing = await this.repository.findAll();
      const existingMap = new Map(existing.map((r) => [r.targetCurrency, r.id]));

      const now = new Date();
      const toInsert: { baseCurrency: string; targetCurrency: string; rate: number; fetchedAt: Date }[] = [];
      const toUpdate: { id: number; rate: number }[] = [];

      for (const [currency, rate] of Object.entries(data.rates)) {
        const existingId = existingMap.get(currency);
        if (existingId !== undefined) {
          toUpdate.push({ id: existingId, rate });
        } else {
          toInsert.push({ baseCurrency: 'USD', targetCurrency: currency, rate, fetchedAt: now });
        }
      }

      await this.repository.bulkInsert(toInsert);
      await Promise.all(toUpdate.map(({ id, rate }) => this.repository.updateRateById(id, rate, now)));

      logger.info(`Exchange rates refreshed — ${Object.keys(data.rates).length} currencies`);
    } catch (error) {
      logger.error(`Error fetching exchange rates - ${error}`);
    }
  }

  async getLatestRates(refCurrency: string): Promise<ExchangeRateResponseDTO[]> {
    try {
      const rates = await this.repository.findAll();
      if (refCurrency === 'USD') {
        return rates.map((r) => ({
          base_currency: r.baseCurrency,
          target_currency: r.targetCurrency,
          rate: r.rate,
          fetched_at: r.fetchedAt,
        }));
      }

      const refToUsd = rates.find((r) => r.targetCurrency === refCurrency);
      if (!refToUsd) return [];

      return rates.map((r) => ({
        base_currency: refCurrency,
        target_currency: r.targetCurrency,
        rate: r.rate / refToUsd.rate,
        fetched_at: r.fetchedAt,
      }));
    } catch (error) {
      logger.error(`Error fetching rates - ${error}`);
      throw new InternalServerException('Failed to fetch exchange rates');
    }
  }

  async convert(amount: number, fromCurrency: string, toCurrency: string): Promise<number> {
    if (fromCurrency === toCurrency) return amount;
    try {
      const rate = await this.getRate(fromCurrency, toCurrency);
      return amount * rate;
    } catch {
      return amount;
    }
  }

  async getRate(fromCurrency: string, toCurrency: string): Promise<number> {
    if (fromCurrency === toCurrency) return 1;
    try {
      if (fromCurrency === 'USD') {
        const rate = await this.repository.findRate('USD', toCurrency);
        return rate?.rate || 1;
      }
      if (toCurrency === 'USD') {
        const rate = await this.repository.findRate('USD', fromCurrency);
        return rate ? 1 / rate.rate : 1;
      }
      const fromUsd = await this.repository.findRate('USD', fromCurrency);
      const toUsd = await this.repository.findRate('USD', toCurrency);
      if (!fromUsd || !toUsd) return 1;
      return toUsd.rate / fromUsd.rate;
    } catch {
      return 1;
    }
  }
}

export default ExchangeRateService;
