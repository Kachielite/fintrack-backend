import { inject, injectable } from 'tsyringe';
import express, { Request } from 'express';
import { BaseController, Controller, Get, Patch, Post } from '@/common/decorators/controller.decorator';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';
import ParserRuleService, { IParserRuleService } from './parser-rule.service';

@injectable()
@Controller('/parser-rules')
class ParserRuleController extends BaseController {
  constructor(
    @inject(ROUTER_TOKENS.PARSER_RULE) router: express.Router,
    @inject(ParserRuleService) private readonly service: IParserRuleService,
  ) {
    super(router);
  }

  /**
   * @swagger
   * /parser-rules/templates:
   *   get:
   *     tags: [Parser Rules]
   *     summary: List all production parser templates
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: List of production templates
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/ParserTemplate'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/templates')
  async listTemplates(_req: Request) {
    return await this.service.listProductionTemplates();
  }

  /**
   * @swagger
   * /parser-rules/templates/{id}:
   *   get:
   *     tags: [Parser Rules]
   *     summary: Get a template with all its regex rules
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
   *         description: Template with rules
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ParserTemplate'
   *       '404':
   *         $ref: '#/components/responses/NotFound'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/templates/:id')
  async getTemplate(req: Request) {
    const id = parseInt(req.params.id as string, 10);
    return await this.service.getTemplate(id);
  }

  /**
   * @swagger
   * /parser-rules/templates/{id}/audit:
   *   post:
   *     tags: [Parser Rules]
   *     summary: Trigger AI audit on a candidate template
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
   *         description: Audit result with pass/fail and suggestions
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AuditResult'
   *       '404':
   *         $ref: '#/components/responses/NotFound'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Post('/templates/:id/audit')
  async auditTemplate(req: Request) {
    const id = parseInt(req.params.id as string, 10);
    return await this.service.auditTemplate(id);
  }

  /**
   * @swagger
   * /parser-rules/templates/bulk-reaudit:
   *   post:
   *     tags: [Parser Rules]
   *     summary: Re-audit all failed_audit templates with the updated pipeline
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: Summary of promoted vs still-failed templates
   */
  @Post('/templates/bulk-reaudit')
  async bulkReauditFailed(_req: Request) {
    return await this.service.bulkReauditFailed();
  }

  /**
   * @swagger
   * /parser-rules/templates/{id}/promote:
   *   patch:
   *     tags: [Parser Rules]
   *     summary: Promote an audited candidate template to production
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
   *         description: Promoted template
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ParserTemplate'
   *       '404':
   *         $ref: '#/components/responses/NotFound'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Patch('/templates/:id/promote')
  async promoteTemplate(req: Request) {
    const id = parseInt(req.params.id as string, 10);
    return await this.service.promoteTemplate(id);
  }
}

export default ParserRuleController;
