import { inject, injectable } from 'tsyringe';
import { IBankRepository } from './bank.repository';
import { IBank } from './bank.interface';
import { BankResponseDTO } from './bank.dto';
import { InternalServerException, ResourceNotFoundException } from '@/common/exception';
import logger from '@/common/lib/logger';

export interface IBankService {
  listBanks(): Promise<BankResponseDTO[]>;
  getBank(id: number): Promise<BankResponseDTO>;
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
