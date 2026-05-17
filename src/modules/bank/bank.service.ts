import { inject, injectable } from 'tsyringe';
import { IBankRepository } from './bank.repository';
import { IBank } from './bank.interface';
import { BankResponseDTO } from './bank.dto';
import { InternalServerException, ResourceNotFoundException } from '@/common/exception';
import logger from '@/common/lib/logger';

export interface IBankService {
  listBanks(): Promise<BankResponseDTO[]>;
  getBank(id: number): Promise<BankResponseDTO>;
  reportSender(senderEmail: string, bankName?: string): Promise<{ matched: boolean; bankName: string | null }>;
}

@injectable()
class BankService implements IBankService {
  constructor(@inject('IBankRepository') private bankRepository: IBankRepository) {}

  async listBanks(): Promise<BankResponseDTO[]> {
    try {
      logger.info('[Bank] Listing all banks');
      const banks = await this.bankRepository.findAll();
      return banks.map((b) => this.mapToDTO(b));
    } catch (error) {
      logger.error(`Error listing banks - ${error}`);
      throw new InternalServerException('Failed to list banks');
    }
  }

  async getBank(id: number): Promise<BankResponseDTO> {
    try {
      logger.info(`[Bank] Fetching bank ${id}`);
      const bank = await this.bankRepository.findById(id);
      if (!bank) throw new ResourceNotFoundException('Bank not found');
      return this.mapToDTO(bank);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) throw error;
      logger.error(`Error fetching bank ${id} - ${error}`);
      throw new InternalServerException('Failed to fetch bank');
    }
  }

  async reportSender(senderEmail: string, bankName?: string): Promise<{ matched: boolean; bankName: string | null }> {
    try {
      const normalized = senderEmail.toLowerCase().trim();

      // 1. Exact / domain match against known banks
      const match = await this.bankRepository.findBySenderEmail(normalized);
      if (match) {
        await this.bankRepository.upsertByShortCode({
          name: match.bank.name,
          shortCode: match.bank.shortCode,
          senderEmail: normalized,
        });
        logger.info(`[Bank] reportSender: matched "${match.bank.name}" for ${normalized}`);
        return { matched: true, bankName: match.bank.name };
      }

      if (!bankName) return { matched: false, bankName: null };

      // 2. Fuzzy name match among existing banks
      const banks = await this.bankRepository.findAll();
      const query = bankName.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
      const fuzzyMatch = banks.find((b) => {
        const name = b.name.toLowerCase().replace(/[^a-z0-9\s]/g, '');
        return name.includes(query) || query.includes(name);
      });

      const target = fuzzyMatch ?? {
        name: bankName.trim(),
        shortCode: bankName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20),
      };

      const bank = await this.bankRepository.upsertByShortCode({
        name: target.name,
        shortCode: target.shortCode,
        senderEmail: normalized,
      });
      logger.info(`[Bank] reportSender: registered "${bank.name}" (${bank.shortCode}) for ${normalized}`);
      return { matched: false, bankName: bank.name };
    } catch (error) {
      logger.error(`[Bank] reportSender error - ${error}`);
      throw new InternalServerException('Failed to report bank sender');
    }
  }

  private mapToDTO(bank: IBank): BankResponseDTO {
    return {
      id: bank.id,
      name: bank.name,
      short_code: bank.shortCode,
      country: bank.country,
      known_sender_emails: bank.knownSenderEmails,
      logo_url: bank.logoUrl,
      is_active: bank.isActive,
    };
  }
}

export default BankService;
