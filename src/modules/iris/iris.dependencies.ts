import express from 'express';
import { container } from 'tsyringe';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';
import IrisController from './iris.controller';
import IrisService from './iris.service';
import IrisRepositoryImpl from './iris.repository';
import EmbeddingService from './embedding/embedding.service';
import RetrievalService from './retrieval/retrieval.service';

export async function registerIrisDependencies(): Promise<void> {
  container.register<express.Router>(ROUTER_TOKENS.IRIS, {
    useFactory: () => express.Router(),
  });

  container.registerSingleton('IIrisRepository', IrisRepositoryImpl);
  container.registerSingleton<EmbeddingService>(EmbeddingService);
  container.registerSingleton<RetrievalService>(RetrievalService);
  container.registerSingleton<IrisService>(IrisService);
  container.registerSingleton<IrisController>(IrisController);
}
