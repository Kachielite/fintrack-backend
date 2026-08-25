import { inject, injectable } from 'tsyringe';
import express, { Request } from 'express';
import { BaseController, Controller, Delete, Get, Patch, Post } from '@/common/decorators/controller.decorator';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';
import CategoryService, { ICategoryService } from './category.service';
import { CreateCategorySchema, CreateCategoryDTO, UpdateCategorySchema, UpdateCategoryDTO } from './category.dto';
import { IAuthenticatedRequest } from '@/common/types/interface';

@injectable()
@Controller('/categories')
class CategoryController extends BaseController {
  constructor(
    @inject(ROUTER_TOKENS.CATEGORY) router: express.Router,
    @inject(CategoryService) private readonly service: ICategoryService,
  ) {
    super(router);
  }

  /**
   * @swagger
   * /categories:
   *   get:
   *     tags: [Categories]
   *     summary: List all categories available to the user (system-wide + their own custom ones)
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: List of categories
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/Category'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Get('/')
  async listCategories(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    return await this.service.listCategories(userId);
  }

  /**
   * @swagger
   * /categories:
   *   post:
   *     tags: [Categories]
   *     summary: Create a custom category
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [name]
   *             properties:
   *               name:
   *                 type: string
   *                 example: Kids' School Fees
   *               icon:
   *                 type: string
   *                 description: Ionicons name
   *                 example: school-outline
   *               type:
   *                 type: string
   *                 enum: [expense, income]
   *                 default: expense
   *     responses:
   *       '201':
   *         description: The created category
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Category'
   *       '400':
   *         $ref: '#/components/responses/BadRequest'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Post('/', { validate: CreateCategorySchema, statusCode: 201 })
  async createCategory(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    return await this.service.createCategory(userId, req.body as CreateCategoryDTO);
  }

  /**
   * @swagger
   * /categories/{id}:
   *   patch:
   *     tags: [Categories]
   *     summary: Update a custom category (system categories cannot be modified)
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               name:
   *                 type: string
   *               icon:
   *                 type: string
   *               type:
   *                 type: string
   *                 enum: [expense, income]
   *     responses:
   *       '200':
   *         description: Updated category
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Category'
   *       '400':
   *         $ref: '#/components/responses/BadRequest'
   *       '404':
   *         $ref: '#/components/responses/NotFound'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Patch('/:id', { validate: UpdateCategorySchema })
  async updateCategory(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const id = parseInt(req.params.id as string, 10);
    return await this.service.updateCategory(userId, id, req.body as UpdateCategoryDTO);
  }

  /**
   * @swagger
   * /categories/{id}:
   *   delete:
   *     tags: [Categories]
   *     summary: Delete a custom category (fails if any transaction still uses it)
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       '200':
   *         description: Deleted
   *       '400':
   *         $ref: '#/components/responses/BadRequest'
   *       '404':
   *         $ref: '#/components/responses/NotFound'
   *       '401':
   *         $ref: '#/components/responses/Unauthorized'
   *       '500':
   *         $ref: '#/components/responses/InternalServerError'
   */
  @Delete('/:id')
  async deleteCategory(req: Request) {
    const userId = (req as unknown as IAuthenticatedRequest).user?.id as number;
    const id = parseInt(req.params.id as string, 10);
    return await this.service.deleteCategory(userId, id);
  }
}

export default CategoryController;
