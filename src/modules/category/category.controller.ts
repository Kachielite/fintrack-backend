import { inject, injectable } from 'tsyringe';
import express, { Request } from 'express';
import { BaseController, Controller, Get } from '@/common/decorators/controller.decorator';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';
import CategoryService, { ICategoryService } from './category.service';

@injectable()
@Controller('/categories')
class CategoryController extends BaseController {
  constructor(
    @inject(ROUTER_TOKENS.CATEGORY) router: express.Router,
    @inject(CategoryService) private readonly service: ICategoryService,
  ) {
    super(router);
  }

  @Get('/')
  async listCategories(_req: Request) {
    return await this.service.listCategories();
  }
}

export default CategoryController;
