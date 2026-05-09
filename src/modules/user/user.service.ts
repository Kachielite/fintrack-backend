import { inject, injectable } from 'tsyringe';
import { IUserRepository } from './user.repository';
import { IUser, ICompleteOnboarding, IUpdateUser } from './user.interface';
import { UpdateUserDTO, CompleteOnboardingDTO, UserResponseDTO } from './user.dto';
import { IGeneralResponse } from '@/common/types/interface';
import {
  InternalServerException,
  ResourceNotFoundException,
  UnAuthorizedException,
} from '@/common/exception';
import logger from '@/common/lib/logger';

export interface IUserService {
  getMe(userId: number): Promise<UserResponseDTO>;
  updateMe(userId: number, data: UpdateUserDTO): Promise<UserResponseDTO>;
  completeOnboarding(userId: number, data: CompleteOnboardingDTO): Promise<UserResponseDTO>;
  deleteMe(userId: number): Promise<IGeneralResponse<null>>;
}

@injectable()
class UserService implements IUserService {
  constructor(@inject('IUserRepository') private userRepository: IUserRepository) {}

  async getMe(userId: number): Promise<UserResponseDTO> {
    try {
      const user = await this.userRepository.findById(userId);
      if (!user) throw new ResourceNotFoundException('User not found');
      return this.mapToDTO(user);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) throw error;
      logger.error(`Error fetching user ${userId} - ${error}`);
      throw new InternalServerException('Failed to fetch user profile');
    }
  }

  async updateMe(userId: number, data: UpdateUserDTO): Promise<UserResponseDTO> {
    try {
      const updateData: Partial<IUpdateUser> = {};
      if (data.first_name) updateData.firstName = data.first_name;
      if (data.last_name !== undefined) updateData.lastName = data.last_name;
      if (data.ref_currency) updateData.refCurrency = data.ref_currency;
      if (data.advisor_tone) updateData.advisorTone = data.advisor_tone;

      const updated = await this.userRepository.updateUser(userId, updateData);
      return this.mapToDTO(updated);
    } catch (error) {
      logger.error(`Error updating user ${userId} - ${error}`);
      throw new InternalServerException('Failed to update user profile');
    }
  }

  async completeOnboarding(userId: number, data: CompleteOnboardingDTO): Promise<UserResponseDTO> {
    try {
      const onboardingData: ICompleteOnboarding = {
        goalType: data.goal_type,
        incomeRange: data.income_range,
        payFrequency: data.pay_frequency,
        refCurrency: data.ref_currency,
      };
      const updated = await this.userRepository.completeOnboarding(userId, onboardingData);
      return this.mapToDTO(updated);
    } catch (error) {
      logger.error(`Error completing onboarding for user ${userId} - ${error}`);
      throw new InternalServerException('Failed to complete onboarding');
    }
  }

  async deleteMe(userId: number): Promise<IGeneralResponse<null>> {
    try {
      const user = await this.userRepository.findById(userId);
      if (!user) throw new ResourceNotFoundException('User not found');
      await this.userRepository.deleteUser(userId);
      return { success: true, message: 'Account deleted successfully', data: null };
    } catch (error) {
      if (error instanceof ResourceNotFoundException) throw error;
      logger.error(`Error deleting user ${userId} - ${error}`);
      throw new InternalServerException('Failed to delete account');
    }
  }

  private mapToDTO(user: IUser): UserResponseDTO {
    return {
      id: user.id,
      email: user.email,
      first_name: user.firstName,
      last_name: user.lastName,
      ref_currency: user.refCurrency,
      advisor_tone: user.advisorTone,
      goal_type: user.goalType,
      income_range: user.incomeRange,
      pay_frequency: user.payFrequency,
      onboarding_complete: user.onboardingComplete,
      plan_tier: user.planTier,
      created_at: user.createdAt,
    };
  }
}

export default UserService;
