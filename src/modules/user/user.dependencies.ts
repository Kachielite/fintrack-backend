import express from 'express';
import { container } from 'tsyringe';
import UserController from './user.controller';
import UserService from './user.service';
import UserRepositoryImpl from './user.repository';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';

export async function registerUserDependencies(): Promise<void> {
  container.register<express.Router>(ROUTER_TOKENS.USER, {
    useFactory: () => express.Router(),
  });

  container.registerSingleton('IUserRepository', UserRepositoryImpl);
  container.registerSingleton<UserService>(UserService);
  container.registerSingleton<UserController>(UserController);

}
