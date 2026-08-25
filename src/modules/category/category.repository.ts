import { inject, injectable } from 'tsyringe';
import { asc, desc, eq, and, isNotNull, isNull, or } from 'drizzle-orm';
import Database from '@/common/lib/database';
import { CategorySchema } from './category.schema';
import { ICategory } from './category.interface';

export interface ICategoryRepository {
  findAll(): Promise<ICategory[]>;
  findBySlug(slug: string): Promise<ICategory | null>;
  findActiveWithRegex(): Promise<ICategory[]>;
  findAllForUser(userId: number): Promise<ICategory[]>;
  findById(id: number): Promise<ICategory | null>;
  existsBySlug(slug: string): Promise<boolean>;
  create(data: { userId: number; name: string; slug: string; icon: string | null; type: string }): Promise<ICategory>;
  update(id: number, data: { name?: string; icon?: string; type?: string }): Promise<ICategory>;
  delete(id: number): Promise<void>;
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

  async findAllForUser(userId: number): Promise<ICategory[]> {
    return (await this.db.client
      .select()
      .from(CategorySchema)
      .where(
        and(
          eq(CategorySchema.isActive, true),
          or(isNull(CategorySchema.userId), eq(CategorySchema.userId, userId)),
        ),
      )
      .orderBy(desc(CategorySchema.isSystem), asc(CategorySchema.name))) as ICategory[];
  }

  async findById(id: number): Promise<ICategory | null> {
    const rows = await this.db.client.select().from(CategorySchema).where(eq(CategorySchema.id, id)).limit(1);
    return (rows[0] as ICategory) ?? null;
  }

  async existsBySlug(slug: string): Promise<boolean> {
    const rows = await this.db.client
      .select({ id: CategorySchema.id })
      .from(CategorySchema)
      .where(eq(CategorySchema.slug, slug))
      .limit(1);
    return rows.length > 0;
  }

  async create(data: {
    userId: number;
    name: string;
    slug: string;
    icon: string | null;
    type: string;
  }): Promise<ICategory> {
    const [row] = await this.db.client
      .insert(CategorySchema)
      .values({
        userId: data.userId,
        name: data.name,
        slug: data.slug,
        icon: data.icon,
        type: data.type,
        isSystem: false,
        isActive: true,
      })
      .returning();
    return row as ICategory;
  }

  async update(id: number, data: { name?: string; icon?: string; type?: string }): Promise<ICategory> {
    const [row] = await this.db.client
      .update(CategorySchema)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(CategorySchema.id, id))
      .returning();
    return row as ICategory;
  }

  async delete(id: number): Promise<void> {
    await this.db.client.delete(CategorySchema).where(eq(CategorySchema.id, id));
  }
}

export default CategoryRepositoryImpl;
