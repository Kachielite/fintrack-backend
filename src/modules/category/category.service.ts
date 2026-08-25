import { inject, injectable } from 'tsyringe';
import { ICategoryRepository } from './category.repository';
import { ICategory } from './category.interface';
import { ITransactionRepository } from '@/modules/transaction/transaction.repository';
import { CreateCategoryDTO, UpdateCategoryDTO } from './category.dto';
import { BadRequestException, InternalServerException, ResourceNotFoundException } from '@/common/exception';
import { IGeneralResponse } from '@/common/types/interface';
import logger from '@/common/lib/logger';

export interface ICategoryService {
  listCategories(userId: number): Promise<ICategory[]>;
  createCategory(userId: number, data: CreateCategoryDTO): Promise<ICategory>;
  updateCategory(userId: number, id: number, data: UpdateCategoryDTO): Promise<ICategory>;
  deleteCategory(userId: number, id: number): Promise<IGeneralResponse<null>>;
}

@injectable()
class CategoryService implements ICategoryService {
  constructor(
    @inject('ICategoryRepository') private categoryRepository: ICategoryRepository,
    @inject('ITransactionRepository') private transactionRepository: ITransactionRepository,
  ) {}

  async listCategories(userId: number): Promise<ICategory[]> {
    try {
      return await this.categoryRepository.findAllForUser(userId);
    } catch (error) {
      logger.error(`Error listing categories - ${error}`);
      throw new InternalServerException('Failed to list categories');
    }
  }

  async createCategory(userId: number, data: CreateCategoryDTO): Promise<ICategory> {
    try {
      const slug = await this.buildUniqueSlug(data.name, userId);
      logger.info(`[Category] Creating custom category "${data.name}" (slug=${slug}) for user ${userId}`);
      return await this.categoryRepository.create({
        userId,
        name: data.name.trim(),
        slug,
        icon: data.icon ?? null,
        type: data.type,
      });
    } catch (error) {
      logger.error(`Error creating category for user ${userId} - ${error}`);
      throw new InternalServerException('Failed to create category');
    }
  }

  async updateCategory(userId: number, id: number, data: UpdateCategoryDTO): Promise<ICategory> {
    try {
      const category = await this.getOwnedCustomCategory(userId, id);

      const updateData: { name?: string; icon?: string; type?: string } = {};
      if (data.name !== undefined) updateData.name = data.name.trim();
      if (data.icon !== undefined) updateData.icon = data.icon;
      if (data.type !== undefined) updateData.type = data.type;

      return await this.categoryRepository.update(category.id, updateData);
    } catch (error) {
      if (error instanceof ResourceNotFoundException || error instanceof BadRequestException) throw error;
      logger.error(`Error updating category ${id} for user ${userId} - ${error}`);
      throw new InternalServerException('Failed to update category');
    }
  }

  async deleteCategory(userId: number, id: number): Promise<IGeneralResponse<null>> {
    try {
      const category = await this.getOwnedCustomCategory(userId, id);

      const inUse = await this.transactionRepository.countByCategory(userId, category.slug);
      if (inUse > 0) {
        throw new BadRequestException(
          `This category is used by ${inUse} transaction${inUse === 1 ? '' : 's'} — recategorize them first`,
        );
      }

      await this.categoryRepository.delete(category.id);
      return { success: true, message: 'Category deleted', data: null };
    } catch (error) {
      if (error instanceof ResourceNotFoundException || error instanceof BadRequestException) throw error;
      logger.error(`Error deleting category ${id} for user ${userId} - ${error}`);
      throw new InternalServerException('Failed to delete category');
    }
  }

  /**
   * System categories always have userId: null, so this ownership check alone
   * already excludes them — a system category can never match a real userId.
   */
  private async getOwnedCustomCategory(userId: number, id: number): Promise<ICategory> {
    const category = await this.categoryRepository.findById(id);
    if (!category || category.userId !== userId) {
      throw new ResourceNotFoundException('Category not found');
    }
    return category;
  }

  private async buildUniqueSlug(name: string, userId: number): Promise<string> {
    const base = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!base) throw new BadRequestException('Category name must contain at least one letter or number');

    let candidate = `${base}_u${userId}`;
    let suffix = 2;
    while (await this.categoryRepository.existsBySlug(candidate)) {
      candidate = `${base}_u${userId}_${suffix}`;
      suffix++;
    }
    return candidate;
  }
}

export default CategoryService;
