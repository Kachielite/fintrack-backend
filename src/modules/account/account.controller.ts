import { inject, injectable } from 'tsyringe';
import express, { Request } from 'express';
import { BaseController, Controller, Get, Patch, Post } from '@/common/decorators/controller.decorator';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';
import AccountService, { IAccountService } from './account.service';
import TransferDetectionService, { ITransferDetectionService } from './transfer-detection.service';
import { CreateAccountDTO, CreateAccountSchema, PatchAccountDTO, PatchAccountSchema } from './account.dto';
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
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/Account'
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
   * /accounts:
   *   post:
   *     tags: [Accounts]
   *     summary: Create a new account
   *     description: >
   *       Dedupes by (bank_id, currency, account_number): if a matching account
   *       already exists (including a deactivated one, which gets reactivated)
   *       it's returned as-is rather than creating a duplicate. account_number
   *       distinguishes two accounts at the same bank in the same currency
   *       (checking vs. savings) that would otherwise collide; an existing
   *       account with no number on file yet is treated as a match and
   *       backfilled, but one with a different number already set is treated
   *       as genuinely different. label is only applied when a new account is
   *       actually created, never used to rename an existing match. Also used
   *       internally by statement import to create an account inline when the
   *       user picks "create new" instead of an existing account.
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [currency]
   *             properties:
   *               currency:
   *                 type: string
   *                 example: KES
   *               bank_id:
   *                 type: integer
   *                 example: 3
   *               label:
   *                 type: string
   *                 example: M-Pesa
   *               account_number:
   *                 type: string
   *                 description: Distinguishes two accounts at the same bank in the same currency (checking vs. savings).
   *                 example: "1234"
   *     responses:
   *       '201':
   *         description: Created (or matched an existing) account
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Account'
   *       '400':
   *         $ref: '#/components/responses/BadRequest'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Post('/', { validate: CreateAccountSchema, statusCode: 201 })
  async createAccount(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    return await this.accountService.createAccount(userId, req.body as CreateAccountDTO);
  }

  /**
   * @swagger
   * /accounts/{id}:
   *   patch:
   *     tags: [Accounts]
   *     summary: Update account details, deactivate, or merge an account
   *     description: >
   *       Provide any combination of label, bank_id, and account_number to
   *       edit those details (useful for filling in fields an
   *       auto-created account never had, e.g. one created by email
   *       ingestion before these fields existed here). merge_into_account_id
   *       is handled on its own, moves every transaction into the target
   *       account and deactivates this one, ignoring any other fields in the
   *       same request.
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
   *               bank_id:
   *                 type: integer
   *                 example: 3
   *               account_number:
   *                 type: string
   *                 example: "1234"
   *     responses:
   *       '200':
   *         description: Updated account
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Account'
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
   *     description: >
   *       Idempotent — safe to run more than once. Only touches transactions not already
   *       excluded from totals. Runs in the background and acknowledges immediately; the
   *       result arrives as a transfer_scan_complete (or transfer_scan_failed) notification.
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: Scan started
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/SuccessResponse'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Post('/rescan-transfers')
  async rescanTransfers(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    return await this.transferDetectionService.rescanForUserAsync(userId);
  }
}

export default AccountController;
