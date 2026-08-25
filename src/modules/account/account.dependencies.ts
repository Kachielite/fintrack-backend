import { container } from 'tsyringe';
import AccountService from './account.service';
import AccountRepositoryImpl from './account.repository';
import TransferLinkRepositoryImpl from './transfer-link.repository';
import TransferDetectionService from './transfer-detection.service';

export async function registerAccountDependencies(): Promise<void> {
  container.registerSingleton('IAccountRepository', AccountRepositoryImpl);
  container.registerSingleton<AccountService>(AccountService);
  container.registerSingleton('ITransferLinkRepository', TransferLinkRepositoryImpl);
  container.registerSingleton<TransferDetectionService>(TransferDetectionService);
}
