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
import EmailConnectionService, {
  IEmailConnectionService,
} from './email-connection.service';
import { GmailCallbackSchema, SetLabelSchema, GmailCallbackDTO, SetLabelDTO } from './email-connection.dto';
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
   *     summary: Handle Gmail OAuth callback and save connection
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
   *         description: Connection created
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
   * /email-connections/{id}/labels:
   *   get:
   *     tags: [Email Connections]
   *     summary: List Gmail labels for this connection (for label picker)
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
   *         description: List of Gmail labels
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/GmailLabel'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/:id/labels')
  async listLabels(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const id = parseInt(req.params.id as string, 10);
    return await this.service.listLabels(id, userId);
  }

  /**
   * @swagger
   * /email-connections/{id}/label:
   *   patch:
   *     tags: [Email Connections]
   *     summary: Set Gmail label to monitor for bank emails
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
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [label_id, label_name]
   *             properties:
   *               label_id:
   *                 type: string
   *                 example: Label_12345
   *               label_name:
   *                 type: string
   *                 example: Bank Alerts
   *     responses:
   *       '200':
   *         description: Label updated
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/EmailConnection'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Patch('/:id/label', { validate: SetLabelSchema })
  async setLabel(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const id = parseInt(req.params.id as string, 10);
    return await this.service.setLabel(id, userId, req.body as SetLabelDTO);
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
