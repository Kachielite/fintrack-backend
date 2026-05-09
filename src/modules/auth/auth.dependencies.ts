import express from 'express';
import { container } from 'tsyringe';
import AuthController from './auth.controller';
import AuthService from './auth.service';
import AuthRepositoryImpl from './auth.repository';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';

export async function registerAuthDependencies(): Promise<void> {
  container.register<express.Router>(ROUTER_TOKENS.AUTH, {
    useFactory: () => express.Router(),
  });

  container.registerSingleton('IAuthRepository', AuthRepositoryImpl);
  container.registerSingleton<AuthService>(AuthService);
  container.registerSingleton<AuthController>(AuthController);

}
