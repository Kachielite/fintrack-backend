import { inject, injectable } from 'tsyringe';
import express, { Request } from 'express';
import {
  BaseController,
  Controller,
  Get,
  Patch,
  Post,
} from '@/common/decorators/controller.decorator';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';
import TransactionService, { ITransactionService } from './transaction.service';
import {
  CorrectTransactionSchema,
  TransactionQuerySchema,
  TransactionSummaryQuerySchema,
  ChartDataQuerySchema,
  ChartDataQueryDTO,
  CorrectTransactionDTO,
  TransactionQueryDTO,
  BulkCategorySchema,
  BulkCategoryDTO,
  MarkTransferSchema,
  MarkTransferDTO,
} from './transaction.dto';
import { IAuthenticatedRequest } from '@/common/types/interface';

@injectable()
@Controller('/transactions')
class TransactionController extends BaseController {
  constructor(
    @inject(ROUTER_TOKENS.TRANSACTION) router: express.Router,
    @inject(TransactionService) private readonly service: ITransactionService,
  ) {
    super(router);
  }

  /**
   * @swagger
   * /transactions:
   *   get:
   *     tags: [Transactions]
   *     summary: List transactions with filters and pagination
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: page
   *         schema:
   *           type: integer
   *           default: 1
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *           default: 20
   *       - in: query
   *         name: category
   *         schema:
   *           type: string
   *           example: groceries
   *       - in: query
   *         name: currency
   *         schema:
   *           type: string
   *           example: NGN
   *       - in: query
   *         name: bank_id
   *         schema:
   *           type: integer
   *       - in: query
   *         name: status
   *         schema:
   *           type: string
   *           example: verified
   *       - in: query
   *         name: date_from
   *         schema:
   *           type: string
   *           format: date-time
   *       - in: query
   *         name: date_to
   *         schema:
   *           type: string
   *           format: date-time
   *       - in: query
   *         name: search
   *         schema:
   *           type: string
   *           example: Shoprite
   *     responses:
   *       '200':
   *         description: Paginated list of transactions
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/PaginatedTransactions'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/', { validate: { query: TransactionQuerySchema } })
  async listTransactions(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    return await this.service.listTransactions(userId, req.query as unknown as TransactionQueryDTO);
  }

  /**
   * @swagger
   * /transactions/summary:
   *   get:
   *     tags: [Transactions]
   *     summary: Monthly spending summary with category and currency breakdown
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: year
   *         schema:
   *           type: integer
   *           example: 2026
   *       - in: query
   *         name: month
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 12
   *           example: 5
   *     responses:
   *       '200':
   *         description: Transaction summary for the specified month
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/TransactionSummary'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/summary', { validate: { query: TransactionSummaryQuerySchema } })
  async getSummary(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const query = req.query as any;
    return await this.service.getSummary(userId, query.year, query.month);
  }

  /**
   * @swagger
   * /transactions/unverified:
   *   get:
   *     tags: [Transactions]
   *     summary: List transactions pending user verification
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: List of unverified transactions
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/Transaction'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/unverified')
  async getUnverified(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    return await this.service.getUnverified(userId);
  }

  @Get('/chart-data', { validate: { query: ChartDataQuerySchema } })
  async getChartData(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const query = req.query as ChartDataQueryDTO;
    return await this.service.getChartData(userId, query.period);
  }

  /**
   * @swagger
   * /transactions/{id}:
   *   get:
   *     tags: [Transactions]
   *     summary: Get a single transaction
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *           example: 42
   *     responses:
   *       '200':
   *         description: Transaction details
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Transaction'
   *       '404':
   *         $ref: '#/components/responses/NotFound'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/:id')
  async getTransaction(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const id = parseInt(req.params.id as string, 10);
    return await this.service.getTransaction(id, userId);
  }

  /**
   * @swagger
   * /transactions/{id}:
   *   patch:
   *     tags: [Transactions]
   *     summary: Correct merchant, category, or amount on a transaction
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *           example: 42
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               merchant:
   *                 type: string
   *                 example: Shoprite Ikeja
   *               category:
   *                 type: string
   *                 example: groceries
   *               transaction_type:
   *                 type: string
   *                 example: debit
   *               amount:
   *                 type: number
   *                 example: -5200
   *     responses:
   *       '200':
   *         description: Corrected transaction
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Transaction'
   *       '404':
   *         $ref: '#/components/responses/NotFound'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Patch('/bulk-category', { validate: BulkCategorySchema })
  async bulkCorrectCategory(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    return await this.service.bulkCorrectCategory(userId, req.body as BulkCategoryDTO);
  }

  @Patch('/:id', { validate: CorrectTransactionSchema })
  async correctTransaction(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const id = parseInt(req.params.id as string, 10);
    return await this.service.correctTransaction(id, userId, req.body as CorrectTransactionDTO);
  }

  @Get('/:id/similar')
  async getSimilarTransactions(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const id = parseInt(req.params.id as string, 10);
    return await this.service.getSimilarTransactions(id, userId);
  }

  /**
   * @swagger
   * /transactions/{id}/mark-transfer:
   *   post:
   *     tags: [Transactions]
   *     summary: Manually mark a transaction as a transfer, excluding it from totals
   *     description: Optionally pair it with the other leg (linked_transaction_id); otherwise it's excluded alone.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *           example: 42
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               linked_transaction_id:
   *                 type: integer
   *                 example: 43
   *     responses:
   *       '200':
   *         description: Updated transaction
   *       '400':
   *         $ref: '#/components/responses/BadRequest'
   *       '404':
   *         $ref: '#/components/responses/NotFound'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Post('/:id/mark-transfer', { validate: MarkTransferSchema })
  async markTransfer(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const id = parseInt(req.params.id as string, 10);
    const { linked_transaction_id } = req.body as MarkTransferDTO;
    return await this.service.markTransfer(userId, id, linked_transaction_id);
  }

  /**
   * @swagger
   * /transactions/{id}/unmark-transfer:
   *   post:
   *     tags: [Transactions]
   *     summary: Undo a transfer mark, including it back in totals
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *           example: 42
   *     responses:
   *       '200':
   *         description: Updated transaction
   *       '404':
   *         $ref: '#/components/responses/NotFound'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Post('/:id/unmark-transfer')
  async unmarkTransfer(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const id = parseInt(req.params.id as string, 10);
    return await this.service.unmarkTransfer(userId, id);
  }

  /**
   * @swagger
   * /transactions/{id}/linked-transaction:
   *   get:
   *     tags: [Transactions]
   *     summary: Fetch the paired leg of a transfer, if any
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *           example: 42
   *     responses:
   *       '200':
   *         description: The linked transaction, or null if this transaction isn't paired
   *       '404':
   *         $ref: '#/components/responses/NotFound'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/:id/linked-transaction')
  async getLinkedTransaction(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const id = parseInt(req.params.id as string, 10);
    return await this.service.getLinkedTransaction(userId, id);
  }
}

export default TransactionController;
