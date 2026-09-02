import { inject, injectable } from 'tsyringe';
import express, { Request } from 'express';
import { BaseController, Controller, Get, Patch, Post } from '@/common/decorators/controller.decorator';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';
import InsightService, { IInsightService } from './insight.service';
import { InsightQuerySchema, InsightQueryDTO } from './insight.dto';
import { IAuthenticatedRequest } from '@/common/types/interface';
import { ConflictException } from '@/common/exception';

@injectable()
@Controller('/insights')
class InsightController extends BaseController {
  constructor(
    @inject(ROUTER_TOKENS.INSIGHT) router: express.Router,
    @inject(InsightService) private readonly service: IInsightService,
  ) {
    super(router);
  }

  /**
   * @swagger
   * /insights:
   *   get:
   *     tags: [Insights]
   *     summary: List active AI-generated insights for the current user
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: unread_only
   *         schema:
   *           type: boolean
   *           example: true
   *     responses:
   *       '200':
   *         description: List of insights
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/Insight'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/', { validate: { query: InsightQuerySchema } })
  async listInsights(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    return await this.service.listInsights(userId, req.query as unknown as InsightQueryDTO);
  }

  /**
   * @swagger
   * /insights/{id}/read:
   *   patch:
   *     tags: [Insights]
   *     summary: Mark an insight as read
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *           example: 7
   *     responses:
   *       '200':
   *         description: Insight marked as read
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Insight'
   *       '404':
   *         $ref: '#/components/responses/NotFound'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Patch('/:id/read')
  async markRead(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const id = parseInt(req.params.id as string, 10);
    return await this.service.markRead(id, userId);
  }

  /**
   * @swagger
   * /insights/generate:
   *   post:
   *     tags: [Insights]
   *     summary: Trigger this week's report generation for the current user
   *     description: Rejects with 409 if this week's report already exists, is currently generating, or a Gmail backfill is still in progress.
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '202':
   *         description: Generation started
   *       '409':
   *         description: This week's report already exists, is already generating, or a backfill is still in progress
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   */
  @Post('/generate', { statusCode: 202 })
  async generate(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;

    if (await this.service.hasActiveBackfill(userId)) {
      throw new ConflictException("Still scanning your email history — check back in a few minutes.");
    }

    const canGenerate = await this.service.canGenerateWeeklyReport(userId);
    if (!canGenerate) {
      throw new ConflictException("You already have this week's report — check back next Monday.");
    }

    this.service.generateWeeklyReportForUser(userId).catch(() => null);
    return { message: 'Insight generation started' };
  }
}

export default InsightController;
