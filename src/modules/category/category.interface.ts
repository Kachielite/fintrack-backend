export interface ICategory {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
  type: string;
  regex: string | null;
  isSystem: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}
