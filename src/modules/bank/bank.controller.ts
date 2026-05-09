import { inject, injectable } from 'tsyringe';
import express, { Request } from 'express';
import { BaseController, Controller, Get } from '@/common/decorators/controller.decorator';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';
import BankService, { IBankService } from './bank.service';

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
}

export default BankController;
