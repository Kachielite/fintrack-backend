import { container } from 'tsyringe';
import AccountService from './account.service';
import AccountRepositoryImpl from './account.repository';

export async function registerAccountDependencies(): Promise<void> {
  container.registerSingleton('IAccountRepository', AccountRepositoryImpl);
  container.registerSingleton<AccountService>(AccountService);
}
