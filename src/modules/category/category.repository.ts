import { inject, injectable } from 'tsyringe';
import { asc, eq, and, isNotNull } from 'drizzle-orm';
import Database from '@/common/lib/database';
import { CategorySchema } from './category.schema';
import { ICategory } from './category.interface';

export interface ICategoryRepository {
  findAll(): Promise<ICategory[]>;
  findBySlug(slug: string): Promise<ICategory | null>;
  findActiveWithRegex(): Promise<ICategory[]>;
}

@injectable()
class CategoryRepositoryImpl implements ICategoryRepository {
  constructor(@inject(Database) private db: Database) {}

  async findAll(): Promise<ICategory[]> {
    return (await this.db.client
      .select()
      .from(CategorySchema)
      .where(eq(CategorySchema.isActive, true))
      .orderBy(CategorySchema.name)) as ICategory[];
  }

  async findBySlug(slug: string): Promise<ICategory | null> {
    const rows = await this.db.client
      .select()
      .from(CategorySchema)
      .where(and(eq(CategorySchema.slug, slug), eq(CategorySchema.isActive, true)))
      .limit(1);
    return (rows[0] as ICategory) ?? null;
  }

  async findActiveWithRegex(): Promise<ICategory[]> {
    return (await this.db.client
      .select()
      .from(CategorySchema)
      .where(and(eq(CategorySchema.isActive, true), isNotNull(CategorySchema.regex)))
      .orderBy(asc(CategorySchema.id))) as ICategory[];
  }
}

export default CategoryRepositoryImpl;
