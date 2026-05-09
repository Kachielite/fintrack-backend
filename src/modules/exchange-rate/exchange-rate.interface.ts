export interface IExchangeRate {
  id: number;
  baseCurrency: string;
  targetCurrency: string;
  rate: number;
  fetchedAt: Date;
}
