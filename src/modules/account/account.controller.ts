import { inject, injectable } from 'tsyringe';
import express, { Request } from 'express';
import { BaseController, Controller, Get, Patch, Post } from '@/common/decorators/controller.decorator';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';
import AccountService, { IAccountService } from './account.service';
import TransferDetectionService, { ITransferDetectionService } from './transfer-detection.service';
import { PatchAccountDTO, PatchAccountSchema } from './account.dto';
import { IAuthenticatedRequest } from '@/common/types/interface';

@injectable()
@Controller('/accounts')
class AccountController extends BaseController {
  constructor(
    @inject(ROUTER_TOKENS.ACCOUNT) router: express.Router,
    @inject(AccountService) private readonly accountService: IAccountService,
    @inject(TransferDetectionService) private readonly transferDetectionService: ITransferDetectionService,
  ) {
    super(router);
  }

  /**
   * @swagger
   * /accounts:
   *   get:
   *     tags: [Accounts]
   *     summary: List the user's accounts, each with its latest known balance
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: List of accounts
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/')
  async listAccounts(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    return await this.accountService.listAccounts(userId);
  }

  /**
   * @swagger
   * /accounts/{id}:
   *   patch:
   *     tags: [Accounts]
   *     summary: Rename, deactivate, or merge an account
   *     description: Provide exactly one of label, is_active, or merge_into_account_id.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *           example: 1
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               label:
   *                 type: string
   *                 example: My Dollar Account
   *               is_active:
   *                 type: boolean
   *               merge_into_account_id:
   *                 type: integer
   *                 example: 2
   *     responses:
   *       '200':
   *         description: Updated account
   *       '400':
   *         $ref: '#/components/responses/BadRequest'
   *       '404':
   *         $ref: '#/components/responses/NotFound'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Patch('/:id', { validate: PatchAccountSchema })
  async updateAccount(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const id = parseInt(req.params.id as string, 10);
    return await this.accountService.updateAccount(userId, id, req.body as PatchAccountDTO);
  }

  /**
   * @swagger
   * /accounts/rescan-transfers:
   *   post:
   *     tags: [Accounts]
   *     summary: Re-scan the user's full transaction history for transfers/conversions
   *     description: Idempotent — safe to run more than once. Only touches transactions not already excluded from totals.
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: Rescan result
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 scanned:
   *                   type: integer
   *                 linked:
   *                   type: integer
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Post('/rescan-transfers')
  async rescanTransfers(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    return await this.transferDetectionService.rescanForUser(userId);
  }
}

export default AccountController;
