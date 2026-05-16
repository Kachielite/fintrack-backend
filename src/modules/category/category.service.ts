import { inject, injectable } from 'tsyringe';
import { ICategoryRepository } from './category.repository';
import { ICategory } from './category.interface';
import { InternalServerException } from '@/common/exception';
import logger from '@/common/lib/logger';

export interface ICategoryService {
  listCategories(): Promise<ICategory[]>;
}

@injectable()
class CategoryService implements ICategoryService {
  constructor(@inject('ICategoryRepository') private categoryRepository: ICategoryRepository) {}

  async listCategories(): Promise<ICategory[]> {
    try {
      return await this.categoryRepository.findAll();
    } catch (error) {
      logger.error(`Error listing categories - ${error}`);
      throw new InternalServerException('Failed to list categories');
    }
  }
}

export default CategoryService;
