import { inject, injectable } from 'tsyringe';
import { IGoalRepository } from './goal.repository';
import { IGoal } from './goal.interface';
import { CreateGoalDTO, UpdateGoalDTO } from './goal.dto';
import { IGeneralResponse } from '@/common/types/interface';
import { InternalServerException, ResourceNotFoundException } from '@/common/exception';
import logger from '@/common/lib/logger';
import { GoalTypeEnum } from '@/modules/user/user.enum';

export interface IGoalService {
  listGoals(userId: number): Promise<IGoal[]>;
  createGoal(userId: number, data: CreateGoalDTO): Promise<IGoal>;
  updateGoal(id: number, userId: number, data: UpdateGoalDTO): Promise<IGoal>;
  deleteGoal(id: number, userId: number): Promise<IGeneralResponse<null>>;
}

@injectable()
class GoalService implements IGoalService {
  constructor(@inject('IGoalRepository') private goalRepository: IGoalRepository) {}

  async listGoals(userId: number): Promise<IGoal[]> {
    try {
      logger.info(`[Goal] Listing goals for user ${userId}`);
      return await this.goalRepository.findAllByUser(userId);
    } catch (error) {
      logger.error(`Error listing goals for user ${userId} - ${error}`);
      throw new InternalServerException('Failed to list goals');
    }
  }

  async createGoal(userId: number, data: CreateGoalDTO): Promise<IGoal> {
    try {
      logger.info(`[Goal] Creating goal "${data.name}" for user ${userId}`);
      return await this.goalRepository.create({
        userId,
        name: data.name,
        type: data.type as GoalTypeEnum,
        targetAmount: data.target_amount,
        currency: data.currency,
        targetDate: data.target_date ? new Date(data.target_date) : undefined,
      });
    } catch (error) {
      logger.error(`Error creating goal for user ${userId} - ${error}`);
      throw new InternalServerException('Failed to create goal');
    }
  }

  async updateGoal(id: number, userId: number, data: UpdateGoalDTO): Promise<IGoal> {
    try {
      logger.info(`[Goal] Updating goal ${id} for user ${userId}`);
      const existing = await this.goalRepository.findById(id, userId);
      if (!existing) throw new ResourceNotFoundException('Goal not found');

      const updateData: Partial<IGoal> = {};
      if (data.name) updateData.name = data.name;
      if (data.target_amount !== undefined) updateData.targetAmount = data.target_amount;
      if (data.saved_amount !== undefined) updateData.savedAmount = data.saved_amount;
      if (data.target_date) updateData.targetDate = new Date(data.target_date);

      return await this.goalRepository.update(id, userId, updateData);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) throw error;
      logger.error(`Error updating goal ${id} - ${error}`);
      throw new InternalServerException('Failed to update goal');
    }
  }

  async deleteGoal(id: number, userId: number): Promise<IGeneralResponse<null>> {
    try {
      logger.info(`[Goal] Deleting goal ${id} for user ${userId}`);
      const existing = await this.goalRepository.findById(id, userId);
      if (!existing) throw new ResourceNotFoundException('Goal not found');
      await this.goalRepository.delete(id, userId);
      return { success: true, message: 'Goal deleted', data: null };
    } catch (error) {
      if (error instanceof ResourceNotFoundException) throw error;
      logger.error(`Error deleting goal ${id} - ${error}`);
      throw new InternalServerException('Failed to delete goal');
    }
  }
}

export default GoalService;
