import { GoalTypeEnum } from '@/modules/user/user.enum';

export interface IGoal {
  id: number;
  userId: number;
  name: string;
  type: string;
  targetAmount: number | null;
  savedAmount: number;
  currency: string;
  targetDate: Date | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ICreateGoal {
  userId: number;
  name: string;
  type: GoalTypeEnum;
  targetAmount?: number;
  currency: string;
  targetDate?: Date;
}
