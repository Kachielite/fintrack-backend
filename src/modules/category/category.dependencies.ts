import express from 'express';
import { container } from 'tsyringe';
import CategoryController from './category.controller';
import CategoryService from './category.service';
import CategoryRepositoryImpl from './category.repository';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';

export async function registerCategoryDependencies(): Promise<void> {
  container.register<express.Router>(ROUTER_TOKENS.CATEGORY, {
    useFactory: () => express.Router(),
  });

  container.registerSingleton('ICategoryRepository', CategoryRepositoryImpl);
  container.registerSingleton<CategoryService>(CategoryService);
  container.registerSingleton<CategoryController>(CategoryController);
}
