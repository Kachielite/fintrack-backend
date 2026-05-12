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
import BudgetService, { IBudgetService } from './budget.service';
import {
  CreateBudgetSchema,
  UpdateBudgetSchema,
  CreateBudgetDTO,
  UpdateBudgetDTO,
} from './budget.dto';
import { IAuthenticatedRequest } from '@/common/types/interface';

@injectable()
@Controller('/budgets')
class BudgetController extends BaseController {
  constructor(
    @inject(ROUTER_TOKENS.BUDGET) router: express.Router,
    @inject(BudgetService) private readonly service: IBudgetService,
  ) {
    super(router);
  }

  /**
   * @swagger
   * /budgets:
   *   get:
   *     tags: [Budgets]
   *     summary: List active budgets with current-period spending progress
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: List of budgets with progress
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/BudgetWithProgress'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/')
  async listBudgets(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    return await this.service.listBudgets(userId);
  }

  /**
   * @swagger
   * /budgets/suggestions:
   *   get:
   *     tags: [Budgets]
   *     summary: AI-generated budget suggestions for unbudgeted spending categories
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: Budget suggestions
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/BudgetSuggestion'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/suggestions')
  async getSuggestions(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    return await this.service.getBudgetSuggestions(userId);
  }

  /**
   * @swagger
   * /budgets/auto-generate:
   *   post:
   *     tags: [Budgets]
   *     summary: Auto-create budgets from full spending history using AI habit analysis
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: Created budgets and skipped categories
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Post('/auto-generate')
  async autoGenerateBudgets(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    return await this.service.autoGenerateBudgets(userId);
  }

  /**
   * @swagger
   * /budgets/{id}/detail:
   *   get:
   *     tags: [Budgets]
   *     summary: Budget detail with merchant breakdown and date-grouped transactions
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *           example: 3
   *     responses:
   *       '200':
   *         description: Full budget detail
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/BudgetDetail'
   *       '404':
   *         $ref: '#/components/responses/NotFound'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/:id/detail')
  async getBudgetDetail(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const id = parseInt(req.params.id as string, 10);
    return await this.service.getBudgetDetail(id, userId);
  }

  /**
   * @swagger
   * /budgets:
   *   post:
   *     tags: [Budgets]
   *     summary: Create a budget for a spending category
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [category, limit_amount, currency]
   *             properties:
   *               category:
   *                 type: string
   *                 example: groceries
   *               limit_amount:
   *                 type: number
   *                 example: 50000
   *               currency:
   *                 type: string
   *                 example: NGN
   *               period_type:
   *                 type: string
   *                 example: monthly
   *     responses:
   *       '201':
   *         description: Created budget
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/BudgetWithProgress'
   *       '400':
   *         $ref: '#/components/responses/BadRequest'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Post('/', { validate: CreateBudgetSchema, statusCode: 201 })
  async createBudget(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    return await this.service.createBudget(userId, req.body as CreateBudgetDTO);
  }

  /**
   * @swagger
   * /budgets/{id}:
   *   patch:
   *     tags: [Budgets]
   *     summary: Update budget limit, period, or active status
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *           example: 3
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               limit_amount:
   *                 type: number
   *                 example: 60000
   *               period_type:
   *                 type: string
   *                 example: monthly
   *               is_active:
   *                 type: boolean
   *                 example: true
   *     responses:
   *       '200':
   *         description: Updated budget (AI suggestions suppressed for 60 days)
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/BudgetWithProgress'
   *       '404':
   *         $ref: '#/components/responses/NotFound'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Patch('/:id', { validate: UpdateBudgetSchema })
  async updateBudget(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const id = parseInt(req.params.id as string, 10);
    return await this.service.updateBudget(id, userId, req.body as UpdateBudgetDTO);
  }

  /**
   * @swagger
   * /budgets/{id}:
   *   delete:
   *     tags: [Budgets]
   *     summary: Deactivate a budget
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *           example: 3
   *     responses:
   *       '200':
   *         description: Budget deactivated
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
  async deleteBudget(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const id = parseInt(req.params.id as string, 10);
    return await this.service.deleteBudget(id, userId);
  }
}

export default BudgetController;
