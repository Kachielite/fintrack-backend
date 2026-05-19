import { inject, injectable } from 'tsyringe';
import { CONSTANTS } from '@/common/configuration/constants';
import { IIrisRepository } from '../iris.repository';
import EmbeddingService, { IEmbeddingService } from '../embedding/embedding.service';

export interface IRetrievalService {
  retrieveContext(userId: number, question: string): Promise<string>;
}

@injectable()
class RetrievalService implements IRetrievalService {
  constructor(
    @inject('IIrisRepository') private irisRepository: IIrisRepository,
    @inject(EmbeddingService) private embeddingService: IEmbeddingService,
  ) {}

  async retrieveContext(userId: number, question: string): Promise<string> {
    const questionEmbedding = await this.embeddingService.embed(question);
    const chunks = await this.irisRepository.findSimilarChunks(
      userId,
      questionEmbedding,
      CONSTANTS.IRIS_RETRIEVAL_TOP_K,
    );

    return chunks
      .filter((c) => c.similarity > 0.3)
      .map((c) => c.content)
      .join('\n\n');
  }
}

export default RetrievalService;
