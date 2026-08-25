import { inject, injectable } from 'tsyringe';
import { IAccountRepository } from './account.repository';
import { IAccount } from './account.interface';
import { AccountResponseDTO, PatchAccountDTO } from './account.dto';
import { IBankRepository } from '@/modules/bank/bank.repository';
import { ITransactionRepository } from '@/modules/transaction/transaction.repository';
import { BadRequestException, InternalServerException, ResourceNotFoundException } from '@/common/exception';
import logger from '@/common/lib/logger';

export interface IAccountService {
  /**
   * Finds the account a transaction belongs to, or creates one. Originally
   * only driven by ingestion observing a (bank, currency) pair; also used by
   * manual transaction entry when the user doesn't pick an existing account.
   */
  resolveOrCreate(userId: number, bankId: number | null, currency: string, mask?: string | null): Promise<IAccount>;
  listAccounts(userId: number): Promise<AccountResponseDTO[]>;
  updateAccount(userId: number, id: number, data: PatchAccountDTO): Promise<AccountResponseDTO>;
  /** Raw account lookup scoped to the owning user — null if it doesn't exist or belongs to someone else. */
  findOwnedAccount(userId: number, accountId: number): Promise<IAccount | null>;
}

@injectable()
class AccountService implements IAccountService {
  constructor(
    @inject('IAccountRepository') private accountRepository: IAccountRepository,
    @inject('IBankRepository') private bankRepository: IBankRepository,
    @inject('ITransactionRepository') private transactionRepository: ITransactionRepository,
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

  async findOwnedAccount(userId: number, accountId: number): Promise<IAccount | null> {
    return await this.accountRepository.findById(accountId, userId);
  }

  async listAccounts(userId: number): Promise<AccountResponseDTO[]> {
    try {
      const accounts = await this.accountRepository.findAllByUser(userId);
      return await Promise.all(accounts.map((a) => this.mapToDTO(a)));
    } catch (error) {
      logger.error(`[Account] listAccounts error for user ${userId} - ${error}`);
      throw new InternalServerException('Failed to list accounts');
    }
  }

  async updateAccount(userId: number, id: number, data: PatchAccountDTO): Promise<AccountResponseDTO> {
    try {
      const account = await this.accountRepository.findById(id, userId);
      if (!account) throw new ResourceNotFoundException('Account not found');

      if (data.merge_into_account_id !== undefined) {
        if (data.merge_into_account_id === id) {
          throw new BadRequestException('Cannot merge an account into itself');
        }
        const target = await this.accountRepository.findById(data.merge_into_account_id, userId);
        if (!target) throw new ResourceNotFoundException('Target account not found');

        const moved = await this.transactionRepository.reassignAccount(userId, id, target.id);
        const merged = await this.accountRepository.update(id, userId, { isActive: false });
        logger.info(`[Account] Merged account ${id} into ${target.id} for user ${userId} (${moved} transaction(s) moved)`);
        return await this.mapToDTO(merged);
      }

      const updateData: { label?: string; isActive?: boolean } = {};
      if (data.label !== undefined) updateData.label = data.label;
      if (data.is_active !== undefined) updateData.isActive = data.is_active;

      const updated = await this.accountRepository.update(id, userId, updateData);
      return await this.mapToDTO(updated);
    } catch (error) {
      if (error instanceof ResourceNotFoundException || error instanceof BadRequestException) throw error;
      logger.error(`[Account] updateAccount error for account ${id} - ${error}`);
      throw new InternalServerException('Failed to update account');
    }
  }

  private async buildDefaultLabel(bankId: number | null, currency: string): Promise<string> {
    if (bankId === null) return `Account (${currency})`;
    const bank = await this.bankRepository.findById(bankId);
    return `${bank?.name ?? 'Account'} (${currency})`;
  }

  private async mapToDTO(account: IAccount): Promise<AccountResponseDTO> {
    const [bank, latest] = await Promise.all([
      account.bankId !== null ? this.bankRepository.findById(account.bankId) : Promise.resolve(null),
      this.transactionRepository.findLatestBalance(account.id),
    ]);

    return {
      id: account.id,
      bank_id: account.bankId,
      bank_name: bank?.name ?? null,
      bank_logo_url: bank?.logoUrl ?? null,
      currency: account.currency,
      label: account.label,
      account_number_mask: account.accountNumberMask,
      is_active: account.isActive,
      balance: latest?.balance ?? null,
      last_synced_at: latest?.transactionDate.toISOString() ?? null,
      created_at: account.createdAt.toISOString(),
    };
  }
}

export default AccountService;
