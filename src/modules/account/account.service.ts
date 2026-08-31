import { inject, injectable } from 'tsyringe';
import { IAccountRepository } from './account.repository';
import { IAccount } from './account.interface';
import { AccountResponseDTO, CreateAccountDTO, PatchAccountDTO } from './account.dto';
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
  resolveOrCreate(
    userId: number,
    bankId: number | null,
    currency: string,
    mask?: string | null,
    label?: string,
  ): Promise<IAccount>;
  /** User-initiated account creation (Accounts screen, or the statement-import account picker) — thin wrapper over resolveOrCreate that returns the API-shaped DTO. */
  createAccount(userId: number, data: CreateAccountDTO): Promise<AccountResponseDTO>;
  listAccounts(userId: number): Promise<AccountResponseDTO[]>;
  updateAccount(userId: number, id: number, data: PatchAccountDTO): Promise<AccountResponseDTO>;
  /** Raw account lookup scoped to the owning user — null if it doesn't exist or belongs to someone else. */
  findOwnedAccount(userId: number, accountId: number): Promise<IAccount | null>;
  /**
   * Deactivates any of the given accounts that now have zero transactions left.
   * Used after an email connection's data is wiped, so an account it alone fed
   * doesn't linger on the accounts page as an empty, orphaned entry.
   */
  deactivateOrphaned(userId: number, candidateAccountIds: number[]): Promise<number>;
}

@injectable()
class AccountService implements IAccountService {
  constructor(
    @inject('IAccountRepository') private accountRepository: IAccountRepository,
    @inject('IBankRepository') private bankRepository: IBankRepository,
    @inject('ITransactionRepository') private transactionRepository: ITransactionRepository,
  ) {}

  async resolveOrCreate(
    userId: number,
    bankId: number | null,
    currency: string,
    mask?: string | null,
    label?: string,
  ): Promise<IAccount> {
    try {
      const existing = await this.accountRepository.findMatch(userId, bankId, currency);
      if (existing) {
        let account = existing;
        // A matching bank/currency account that was deactivated (e.g. emptied out by
        // an earlier "delete connection data") is seeing a transaction again — surface
        // it rather than silently reattaching data to a hidden account.
        if (!account.isActive) {
          logger.info(`[Account] Reactivating account ${account.id} for user ${userId} on new matching data`);
          account = await this.accountRepository.update(account.id, userId, { isActive: true });
        }
        // Backfill the mask once we see it, even if the account was first created without one.
        if (mask && !account.accountNumberMask) {
          account = await this.accountRepository.setMask(account.id, mask);
        }
        // Deliberately not renaming on reuse — a caller passing a custom label
        // (e.g. a user explicitly creating an account) shouldn't silently
        // rename an existing account it happened to match by (bankId, currency).
        return account;
      }

      const resolvedLabel = label ?? (await this.buildDefaultLabel(bankId, currency));
      logger.info(`[Account] Creating account for user ${userId}: ${resolvedLabel}`);
      return await this.accountRepository.create({
        userId,
        bankId,
        currency,
        label: resolvedLabel,
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

  async createAccount(userId: number, data: CreateAccountDTO): Promise<AccountResponseDTO> {
    const account = await this.resolveOrCreate(userId, data.bank_id ?? null, data.currency, null, data.label);
    return await this.mapToDTO(account);
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

  async deactivateOrphaned(userId: number, candidateAccountIds: number[]): Promise<number> {
    try {
      if (candidateAccountIds.length === 0) return 0;
      let deactivated = 0;
      for (const accountId of candidateAccountIds) {
        const remaining = await this.transactionRepository.countByAccount(userId, accountId);
        if (remaining > 0) continue;
        await this.accountRepository.update(accountId, userId, { isActive: false });
        deactivated++;
      }
      logger.info(`[Account] Deactivated ${deactivated} orphaned account(s) for user ${userId}`);
      return deactivated;
    } catch (error) {
      logger.error(`[Account] deactivateOrphaned error for user ${userId} - ${error}`);
      throw new InternalServerException('Failed to clean up orphaned accounts');
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
