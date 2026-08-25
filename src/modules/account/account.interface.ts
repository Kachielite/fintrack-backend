export interface IAccount {
  id: number;
  userId: number;
  bankId: number | null;
  currency: string;
  label: string;
  accountNumberMask: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}
