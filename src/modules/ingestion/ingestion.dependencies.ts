import { container } from 'tsyringe';
import IngestionService from './ingestion.service';
import IngestionRepositoryImpl from './ingestion.repository';
import { startIngestionWorker } from './ingestion.queue';

export async function registerIngestionDependencies(): Promise<void> {
  container.registerSingleton('IIngestionRepository', IngestionRepositoryImpl);
  container.registerSingleton<IngestionService>(IngestionService);
  startIngestionWorker();
}

