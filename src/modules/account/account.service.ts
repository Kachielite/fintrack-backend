import { inject, injectable } from 'tsyringe';
import { IAccountRepository } from './account.repository';
import { IAccount } from './account.interface';
import { IBankRepository } from '@/modules/bank/bank.repository';
import { InternalServerException } from '@/common/exception';
import logger from '@/common/lib/logger';

export interface IAccountService {
  /**
   * Finds the account a newly-parsed transaction belongs to, or creates one.
   * Accounts are, for now, entirely email-driven: there is no user-initiated
   * account creation, only resolution from what ingestion observes.
   */
  resolveOrCreate(userId: number, bankId: number | null, currency: string, mask?: string | null): Promise<IAccount>;
}

@injectable()
class AccountService implements IAccountService {
  constructor(
    @inject('IAccountRepository') private accountRepository: IAccountRepository,
    @inject('IBankRepository') private bankRepository: IBankRepository,
  ) {}

  async resolveOrCreate(userId: number, bankId: number | null, currency: string, mask?: string | null): Promise<IAccount> {
    try {
      const existing = await this.accountRepository.findMatch(userId, bankId, currency);
      if (existing) {
        // Backfill the mask once we see it, even if the account was first created without one.
        if (mask && !existing.accountNumberMask) {
          return await this.accountRepository.setMask(existing.id, mask);
        }
        return existing;
      }

      const label = await this.buildDefaultLabel(bankId, currency);
      logger.info(`[Account] Creating account for user ${userId}: ${label}`);
      return await this.accountRepository.create({
        userId,
        bankId,
        currency,
        label,
        accountNumberMask: mask ?? null,
      });
    } catch (error) {
      logger.error(`[Account] resolveOrCreate error for user ${userId} - ${error}`);
      throw new InternalServerException('Failed to resolve account');
    }
  }

  private async buildDefaultLabel(bankId: number | null, currency: string): Promise<string> {
    if (bankId === null) return `Account (${currency})`;
    const bank = await this.bankRepository.findById(bankId);
    return `${bank?.name ?? 'Account'} (${currency})`;
  }
}

export default AccountService;
