import { inject, injectable } from 'tsyringe';
import express, { Request } from 'express';
import {
  BaseController,
  Controller,
  Delete,
  Get,
  Patch,
  Post,
} from '@/common/decorators/controller.decorator';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';
import UserService, { IUserService } from './user.service';
import {
  UpdateUserSchema,
  CompleteOnboardingSchema,
  UpdateUserDTO,
  CompleteOnboardingDTO,
} from './user.dto';
import { IAuthenticatedRequest } from '@/common/types/interface';

@injectable()
@Controller('/users')
class UserController extends BaseController {
  constructor(
    @inject(ROUTER_TOKENS.USER) router: express.Router,
    @inject(UserService) private readonly userService: IUserService,
  ) {
    super(router);
  }

  /**
   * @swagger
   * /users/me:
   *   get:
   *     tags: [Users]
   *     summary: Get current user profile
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: User profile
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/UserProfile'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/me')
  async getMe(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    return await this.userService.getMe(userId);
  }

  /**
   * @swagger
   * /users/me:
   *   patch:
   *     tags: [Users]
   *     summary: Update current user profile
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               first_name:
   *                 type: string
   *                 example: Jane
   *               last_name:
   *                 type: string
   *                 example: Doe
   *               ref_currency:
   *                 type: string
   *                 example: NGN
   *               advisor_tone:
   *                 type: string
   *                 example: motivational
   *               goal_type:
   *                 type: string
   *                 example: save
   *               income_range:
   *                 type: string
   *                 example: 500k-1m
   *               pay_frequency:
   *                 type: string
   *                 example: monthly
   *     responses:
   *       '200':
   *         description: Updated user profile
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/UserProfile'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Patch('/me', { validate: UpdateUserSchema })
  async updateMe(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    return await this.userService.updateMe(userId, req.body as UpdateUserDTO);
  }

  /**
   * @swagger
   * /users/me/onboarding:
   *   post:
   *     tags: [Users]
   *     summary: Complete onboarding
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [goal_type, income_range, pay_frequency, ref_currency]
   *             properties:
   *               goal_type:
   *                 type: string
   *                 example: save_money
   *               income_range:
   *                 type: string
   *                 example: 500k-1m
   *               pay_frequency:
   *                 type: string
   *                 example: monthly
   *               ref_currency:
   *                 type: string
   *                 example: NGN
   *     responses:
   *       '200':
   *         description: Onboarding completed
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/UserProfile'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Post('/me/onboarding', { validate: CompleteOnboardingSchema })
  async completeOnboarding(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    return await this.userService.completeOnboarding(userId, req.body as CompleteOnboardingDTO);
  }

  /**
   * @swagger
   * /users/me:
   *   delete:
   *     tags: [Users]
   *     summary: Schedule account deletion
   *     description: >
   *       Schedules the account for deletion rather than deleting it immediately.
   *       The account and all its data remain intact for a 14-day grace period;
   *       logging back in during that window (email/password, Google, or Apple)
   *       reactivates the account automatically. After 14 days, a scheduled job
   *       permanently and irreversibly deletes the account and all dependent data.
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: Account scheduled for deletion
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/SuccessResponse'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Delete('/me')
  async deleteMe(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    return await this.userService.deleteMe(userId);
  }
}

export default UserController;
