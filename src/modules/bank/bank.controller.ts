import { inject, injectable } from 'tsyringe';
import express, { Request } from 'express';
import { BaseController, Controller, Get, Post } from '@/common/decorators/controller.decorator';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';
import BankService, { IBankService } from './bank.service';
import { ReportSenderSchema } from './bank.dto';

@injectable()
@Controller('/banks')
class BankController extends BaseController {
  constructor(
    @inject(ROUTER_TOKENS.BANK) router: express.Router,
    @inject(BankService) private readonly bankService: IBankService,
  ) {
    super(router);
  }

  /**
   * @swagger
   * /banks:
   *   get:
   *     tags: [Banks]
   *     summary: List all active banks
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: List of banks
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/Bank'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/')
  async listBanks(_req: Request) {
    return await this.bankService.listBanks();
  }

  /**
   * @swagger
   * /banks/{id}:
   *   get:
   *     tags: [Banks]
   *     summary: Get single bank
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *           example: 1
   *     responses:
   *       '200':
   *         description: Bank details
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Bank'
   *       '404':
   *         $ref: '#/components/responses/NotFound'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/:id')
  async getBank(req: Request) {
    const id = parseInt(req.params.id as string, 10);
    return await this.bankService.getBank(id);
  }

  /**
   * @swagger
   * /banks/report-sender:
   *   post:
   *     tags: [Banks]
   *     summary: Report a bank sender email not yet recognised by Vela
   *     description: Adds the sender to the global bank knowledge so future emails from this address are detected automatically for all users.
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [sender_email]
   *             properties:
   *               sender_email:
   *                 type: string
   *                 format: email
   *                 example: ebusinessgroup@zenithbank.com
   *               bank_name:
   *                 type: string
   *                 example: Zenith Bank
   *     responses:
   *       '200':
   *         description: Sender registered
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 matched:
   *                   type: boolean
   *                 bankName:
   *                   type: string
   *                   nullable: true
   *       '400':
   *         $ref: '#/components/responses/BadRequest'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Post('/report-sender', { validate: ReportSenderSchema })
  async reportSender(req: Request) {
    const userId = (req as any).user.id as number;
    const { sender_email, bank_name } = req.body as { sender_email: string; bank_name?: string };
    return await this.bankService.reportSender(userId, sender_email, bank_name);
  }
}

export default BankController;
