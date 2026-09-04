import { inject, injectable } from 'tsyringe';
import express, { Request } from 'express';
import {
  BaseController,
  Controller,
  Get,
  Post,
  Patch,
} from '@/common/decorators/controller.decorator';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';
import { adminAuthMiddleware } from '@/middleware/admin.middleware';
import { IAdminService } from './admin.service';
import {
  AdminDateRangeSchema,
  AdminLoginSchema,
  AdminChangePasswordSchema,
  RegexTemplateQuerySchema,
} from './admin.dto';

/**
 * @swagger
 * tags:
 *   name: Admin
 *   description: Internal admin analytics and auth (JWT Bearer required except POST /admin/auth/login)
 */

/**
 * @swagger
 * components:
 *   securitySchemes:
 *     AdminBearer:
 *       type: http
 *       scheme: bearer
 *       bearerFormat: JWT
 */

@injectable()
@Controller('/admin')
class AdminController extends BaseController {
  constructor(
    @inject(ROUTER_TOKENS.ADMIN) router: express.Router,
    @inject('IAdminService') private service: IAdminService,
  ) {
    // Skip JWT check for the login endpoint only
    router.use((req, _res, next) => {
      if (req.path === '/auth/login' && req.method === 'POST') return next();
      return adminAuthMiddleware(req, _res, next);
    });
    super(router);
  }

  /**
   * @swagger
   * /admin/auth/login:
   *   post:
   *     tags: [Admin]
   *     summary: Admin login — returns a short-lived JWT
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [email, password]
   *             properties:
   *               email: { type: string, format: email }
   *               password: { type: string }
   *     responses:
   *       '200':
   *         description: Admin JWT issued
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminAuthToken'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Post('/auth/login', { validate: AdminLoginSchema })
  async login(req: Request) {
    const { email, password } = req.body as { email: string; password: string };
    const data = await this.service.login(email, password);
    return { success: true, data };
  }

  /**
   * @swagger
   * /admin/auth/logout:
   *   post:
   *     tags: [Admin]
   *     summary: Admin logout — stateless, discard token client-side
   *     security:
   *       - AdminBearer: []
   *     responses:
   *       '200':
   *         description: Logged out
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success: { type: boolean, example: true }
   *                 message: { type: string, example: 'Logged out.' }
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   */
  @Post('/auth/logout')
  async logout(_req: Request) {
    return { success: true, message: 'Logged out.' };
  }

  /**
   * @swagger
   * /admin/auth/me:
   *   get:
   *     tags: [Admin]
   *     summary: Return the authenticated admin's id and email
   *     security:
   *       - AdminBearer: []
   *     responses:
   *       '200':
   *         description: Admin info
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminMe'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/auth/me')
  async getMe(req: Request) {
    const adminId = (req as any).adminId as number;
    const data = await this.service.getMe(adminId);
    return { success: true, data };
  }

  /**
   * @swagger
   * /admin/auth/me/password:
   *   patch:
   *     tags: [Admin]
   *     summary: Change the authenticated admin's password
   *     security:
   *       - AdminBearer: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [current_password, new_password]
   *             properties:
   *               current_password: { type: string }
   *               new_password: { type: string, minLength: 8 }
   *     responses:
   *       '200':
   *         description: Password changed
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success: { type: boolean, example: true }
   *                 message: { type: string, example: 'Password updated.' }
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Patch('/auth/me/password', { validate: AdminChangePasswordSchema })
  async changePassword(req: Request) {
    const adminId = (req as any).adminId as number;
    const { current_password, new_password } = req.body as { current_password: string; new_password: string };
    await this.service.changePassword(adminId, current_password, new_password);
    return { success: true, message: 'Password updated.' };
  }

  /**
   * @swagger
   * /admin/overview:
   *   get:
   *     tags: [Admin]
   *     summary: System-wide overview snapshot
   *     security:
   *       - AdminBearer: []
   *     responses:
   *       '200':
   *         description: Overview stats
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminOverview'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/overview')
  async getOverview(_req: Request) {
    return { success: true, data: await this.service.getOverview() };
  }

  /**
   * @swagger
   * /admin/regex/health:
   *   get:
   *     tags: [Admin]
   *     summary: Regex engine health across all banks
   *     security:
   *       - AdminBearer: []
   *     responses:
   *       '200':
   *         description: Regex health report
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminRegexHealth'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/regex/health')
  async getRegexHealth(_req: Request) {
    return { success: true, data: await this.service.getRegexHealth() };
  }

  /**
   * @swagger
   * /admin/regex/templates:
   *   get:
   *     tags: [Admin]
   *     summary: Paginated list of all parser templates
   *     security:
   *       - AdminBearer: []
   *     parameters:
   *       - in: query
   *         name: page
   *         schema: { type: integer, default: 1 }
   *       - in: query
   *         name: limit
   *         schema: { type: integer, default: 25 }
   *       - in: query
   *         name: status
   *         schema: { type: string }
   *       - in: query
   *         name: bank_id
   *         schema: { type: integer }
   *       - in: query
   *         name: sort_by
   *         schema: { type: string, enum: [confidence_score, match_count, created_at, last_failed_at] }
   *       - in: query
   *         name: sort_order
   *         schema: { type: string, enum: [asc, desc] }
   *     responses:
   *       '200':
   *         description: Paginated template list
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminRegexTemplateList'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/regex/templates')
  async getRegexTemplates(req: Request) {
    const query = RegexTemplateQuerySchema.parse(req.query);
    return { success: true, data: await this.service.getRegexTemplates(query) };
  }

  /**
   * @swagger
   * /admin/regex/audit-queue:
   *   get:
   *     tags: [Admin]
   *     summary: Templates awaiting audit review
   *     security:
   *       - AdminBearer: []
   *     responses:
   *       '200':
   *         description: Audit queue
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminAuditQueue'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/regex/audit-queue')
  async getAuditQueue(_req: Request) {
    return { success: true, data: await this.service.getAuditQueue() };
  }

  /**
   * @swagger
   * /admin/regex/templates/{id}/audit:
   *   post:
   *     tags: [Admin]
   *     summary: Audit a candidate template (admin-authenticated equivalent of POST /parser-rules/templates/{id}/audit)
   *     security:
   *       - AdminBearer: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *           example: 1
   *     responses:
   *       '200':
   *         description: Audit result
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AuditResult'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '404':
   *         $ref: '#/components/responses/NotFound'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Post('/regex/templates/:id/audit')
  async auditTemplate(req: Request) {
    const id = parseInt(req.params.id as string, 10);
    return { success: true, data: await this.service.auditTemplate(id) };
  }

  /**
   * @swagger
   * /admin/regex/templates/{id}/promote:
   *   patch:
   *     tags: [Admin]
   *     summary: Promote an audited candidate template to production (admin-authenticated equivalent of PATCH /parser-rules/templates/{id}/promote)
   *     security:
   *       - AdminBearer: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *           example: 1
   *     responses:
   *       '200':
   *         description: Promoted template
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ParserTemplate'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '404':
   *         $ref: '#/components/responses/NotFound'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Patch('/regex/templates/:id/promote')
  async promoteTemplate(req: Request) {
    const id = parseInt(req.params.id as string, 10);
    return { success: true, data: await this.service.promoteTemplate(id) };
  }

  /**
   * @swagger
   * /admin/regex/templates/bulk-reaudit:
   *   post:
   *     tags: [Admin]
   *     summary: Re-audit all failed_audit/demoted templates with the updated pipeline (admin-authenticated equivalent of POST /parser-rules/templates/bulk-reaudit)
   *     security:
   *       - AdminBearer: []
   *     responses:
   *       '200':
   *         description: Summary of promoted vs still-failed templates
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Post('/regex/templates/bulk-reaudit')
  async bulkReauditFailed(_req: Request) {
    return { success: true, data: await this.service.bulkReauditFailed() };
  }

  /**
   * @swagger
   * /admin/regex/gaps:
   *   get:
   *     tags: [Admin]
   *     summary: Banks with unhandled transactions and no production templates
   *     security:
   *       - AdminBearer: []
   *     responses:
   *       '200':
   *         description: Regex gaps report
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminRegexGaps'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/regex/gaps')
  async getRegexGaps(_req: Request) {
    return { success: true, data: await this.service.getRegexGaps() };
  }

  /**
   * @swagger
   * /admin/regex/corrections:
   *   get:
   *     tags: [Admin]
   *     summary: Templates with the highest user-correction rates
   *     security:
   *       - AdminBearer: []
   *     responses:
   *       '200':
   *         description: Correction rates by template
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminRegexCorrections'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/regex/corrections')
  async getRegexCorrections(_req: Request) {
    return { success: true, data: await this.service.getRegexCorrections() };
  }

  /**
   * @swagger
   * /admin/ingestion/health:
   *   get:
   *     tags: [Admin]
   *     summary: Email ingestion pipeline health
   *     security:
   *       - AdminBearer: []
   *     responses:
   *       '200':
   *         description: Ingestion health stats
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminIngestionHealth'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/ingestion/health')
  async getIngestionHealth(_req: Request) {
    return { success: true, data: await this.service.getIngestionHealth() };
  }

  /**
   * @swagger
   * /admin/ingestion/timeline:
   *   get:
   *     tags: [Admin]
   *     summary: Daily ingestion volumes over a date range
   *     security:
   *       - AdminBearer: []
   *     parameters:
   *       - in: query
   *         name: from
   *         schema: { type: string, format: date-time }
   *       - in: query
   *         name: to
   *         schema: { type: string, format: date-time }
   *     responses:
   *       '200':
   *         description: Ingestion timeline buckets
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminIngestionTimeline'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/ingestion/timeline')
  async getIngestionTimeline(req: Request) {
    const range = AdminDateRangeSchema.parse(req.query);
    return { success: true, data: await this.service.getIngestionTimeline(range) };
  }

  /**
   * @swagger
   * /admin/transactions/volume:
   *   get:
   *     tags: [Admin]
   *     summary: Transaction volume breakdown by bank, currency, and category
   *     security:
   *       - AdminBearer: []
   *     parameters:
   *       - in: query
   *         name: from
   *         schema: { type: string, format: date-time }
   *       - in: query
   *         name: to
   *         schema: { type: string, format: date-time }
   *     responses:
   *       '200':
   *         description: Transaction volume report
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminTransactionVolume'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/transactions/volume')
  async getTransactionVolume(req: Request) {
    const range = AdminDateRangeSchema.parse(req.query);
    return { success: true, data: await this.service.getTransactionVolume(range) };
  }

  /**
   * @swagger
   * /admin/users/stats:
   *   get:
   *     tags: [Admin]
   *     summary: User growth, retention, and onboarding funnel stats
   *     security:
   *       - AdminBearer: []
   *     responses:
   *       '200':
   *         description: User statistics
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminUserStats'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/users/stats')
  async getUserStats(_req: Request) {
    return { success: true, data: await this.service.getUserStats() };
  }

  /**
   * @swagger
   * /admin/users/{userId}/regex-stat:
   *   get:
   *     tags: [Admin]
   *     summary: Per-user regex vs AI handling breakdown
   *     security:
   *       - AdminBearer: []
   *     parameters:
   *       - in: path
   *         name: userId
   *         required: true
   *         schema: { type: integer }
   *     responses:
   *       '200':
   *         description: User regex stats
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminUserRegexStat'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '404':
   *         $ref: '#/components/responses/NotFound'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/users/:userId/regex-stat')
  async getUserRegexStat(req: Request) {
    const userId = parseInt(req.params.userId as string, 10);
    return { success: true, data: await this.service.getUserRegexStat(userId) };
  }

  /**
   * @swagger
   * /admin/ai/usage:
   *   get:
   *     tags: [Admin]
   *     summary: AI token usage and cost breakdown over a date range
   *     security:
   *       - AdminBearer: []
   *     parameters:
   *       - in: query
   *         name: from
   *         schema: { type: string, format: date-time }
   *       - in: query
   *         name: to
   *         schema: { type: string, format: date-time }
   *     responses:
   *       '200':
   *         description: AI usage report
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminAiUsage'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/ai/usage')
  async getAiUsage(req: Request) {
    const range = AdminDateRangeSchema.parse(req.query);
    return { success: true, data: await this.service.getAiUsage(range) };
  }
}

export default AdminController;
