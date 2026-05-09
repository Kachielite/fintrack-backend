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
import GoalService, { IGoalService } from './goal.service';
import {
  CreateGoalSchema,
  UpdateGoalSchema,
  CreateGoalDTO,
  UpdateGoalDTO,
} from './goal.dto';
import { IAuthenticatedRequest } from '@/common/types/interface';

@injectable()
@Controller('/goals')
class GoalController extends BaseController {
  constructor(
    @inject(ROUTER_TOKENS.GOAL) router: express.Router,
    @inject(GoalService) private readonly service: IGoalService,
  ) {
    super(router);
  }

  /**
   * @swagger
   * /goals:
   *   get:
   *     tags: [Goals]
   *     summary: List user goals
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: List of goals
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/Goal'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/')
  async listGoals(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    return await this.service.listGoals(userId);
  }

  /**
   * @swagger
   * /goals:
   *   post:
   *     tags: [Goals]
   *     summary: Create a savings or debt goal
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [name, type, currency]
   *             properties:
   *               name:
   *                 type: string
   *                 example: Emergency Fund
   *               type:
   *                 type: string
   *                 example: emergency_fund
   *               target_amount:
   *                 type: number
   *                 example: 500000
   *               currency:
   *                 type: string
   *                 example: NGN
   *               target_date:
   *                 type: string
   *                 format: date-time
   *                 example: '2026-12-31T00:00:00.000Z'
   *     responses:
   *       '201':
   *         description: Created goal
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Goal'
   *       '400':
   *         $ref: '#/components/responses/BadRequest'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Post('/', { validate: CreateGoalSchema, statusCode: 201 })
  async createGoal(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    return await this.service.createGoal(userId, req.body as CreateGoalDTO);
  }

  /**
   * @swagger
   * /goals/{id}:
   *   patch:
   *     tags: [Goals]
   *     summary: Update goal name, target amount, saved amount, or target date
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *           example: 2
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               name:
   *                 type: string
   *                 example: Emergency Fund
   *               target_amount:
   *                 type: number
   *                 example: 600000
   *               saved_amount:
   *                 type: number
   *                 example: 150000
   *               target_date:
   *                 type: string
   *                 format: date-time
   *     responses:
   *       '200':
   *         description: Updated goal
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Goal'
   *       '404':
   *         $ref: '#/components/responses/NotFound'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Patch('/:id', { validate: UpdateGoalSchema })
  async updateGoal(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const id = parseInt(req.params.id as string, 10);
    return await this.service.updateGoal(id, userId, req.body as UpdateGoalDTO);
  }

  /**
   * @swagger
   * /goals/{id}:
   *   delete:
   *     tags: [Goals]
   *     summary: Delete a goal
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *           example: 2
   *     responses:
   *       '200':
   *         description: Goal deleted
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/SuccessResponse'
   *       '404':
   *         $ref: '#/components/responses/NotFound'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Delete('/:id')
  async deleteGoal(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const id = parseInt(req.params.id as string, 10);
    return await this.service.deleteGoal(id, userId);
  }
}

export default GoalController;
