import { inject, injectable } from 'tsyringe';
import express, { Request } from 'express';
import {
  BaseController,
  Controller,
  Delete,
  Get,
  Post,
} from '@/common/decorators/controller.decorator';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';
import EmailConnectionService, {
  IEmailConnectionService,
} from './email-connection.service';
import { GmailCallbackSchema, GmailCallbackDTO } from './email-connection.dto';
import { IAuthenticatedRequest } from '@/common/types/interface';

@injectable()
@Controller('/email-connections')
class EmailConnectionController extends BaseController {
  constructor(
    @inject(ROUTER_TOKENS.EMAIL_CONNECTION) router: express.Router,
    @inject(EmailConnectionService) private readonly service: IEmailConnectionService,
  ) {
    super(router);
  }

  /**
   * @swagger
   * /email-connections/google/auth-url:
   *   get:
   *     tags: [Email Connections]
   *     summary: Get Google OAuth URL for Gmail access
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: OAuth redirect URL
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/GmailAuthUrl'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/google/auth-url')
  async getAuthUrl(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const url = this.service.getAuthUrl(userId);
    return { url };
  }

  /**
   * @swagger
   * /email-connections/google/callback:
   *   post:
   *     tags: [Email Connections]
   *     summary: Exchange OAuth code for tokens. Automatically creates the Bank Transactions label and filter in the user's Gmail. Triggers async backfill of existing matching emails.
   *     description: Uses the gmail.modify scope to read emails, create labels, create filters, and apply labels to messages. Does not allow sending emails or permanent deletion.
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [code, redirect_uri]
   *             properties:
   *               code:
   *                 type: string
   *                 example: 4/0AX4XfWj...
   *               redirect_uri:
   *                 type: string
   *                 example: 'https://app.fintrack.io/callback'
   *     responses:
   *       '201':
   *         description: Connection created with Bank Transactions label and filter set up automatically
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/EmailConnection'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Post('/google/callback', { validate: GmailCallbackSchema, statusCode: 201 })
  async handleCallback(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    return await this.service.handleCallback(userId, req.body as GmailCallbackDTO);
  }

  /**
   * @swagger
   * /email-connections:
   *   get:
   *     tags: [Email Connections]
   *     summary: List all email connections for the current user
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: List of connections
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/EmailConnection'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/')
  async listConnections(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    return await this.service.listConnections(userId);
  }

  /**
   * @swagger
   * /email-connections/{id}:
   *   get:
   *     tags: [Email Connections]
   *     summary: Get a single email connection
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
   *         description: Connection details
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/EmailConnection'
   *       '404':
   *         $ref: '#/components/responses/NotFound'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/:id')
  async getConnection(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const id = parseInt(req.params.id as string, 10);
    return await this.service.getConnection(id, userId);
  }

  /**
   * @swagger
   * /email-connections/{id}/sync:
   *   post:
   *     tags: [Email Connections]
   *     summary: Trigger a manual Gmail sync for this connection
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
   *         description: Sync triggered
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/SuccessResponse'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Post('/:id/sync')
  async triggerSync(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const id = parseInt(req.params.id as string, 10);
    return await this.service.triggerSync(id, userId);
  }

  @Get('/:id/stats')
  async getStats(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const id = parseInt(req.params.id as string, 10);
    return await this.service.getStats(id, userId);
  }

  @Delete('/:id/data')
  async deleteConnectionData(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const id = parseInt(req.params.id as string, 10);
    return await this.service.deleteConnectionData(id, userId);
  }

  /**
   * @swagger
   * /email-connections/{id}:
   *   delete:
   *     tags: [Email Connections]
   *     summary: Remove an email connection
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
   *         description: Connection removed
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/SuccessResponse'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Delete('/:id')
  async deleteConnection(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const id = parseInt(req.params.id as string, 10);
    return await this.service.deleteConnection(id, userId);
  }
}

export default EmailConnectionController;
