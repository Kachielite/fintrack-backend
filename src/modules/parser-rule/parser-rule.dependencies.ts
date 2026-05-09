import express from 'express';
import { container } from 'tsyringe';
import ParserRuleController from './parser-rule.controller';
import ParserRuleService from './parser-rule.service';
import ParserRuleRepositoryImpl from './parser-rule.repository';
import { ROUTER_TOKENS } from '@/common/constants/router.tokens';

export async function registerParserRuleDependencies(): Promise<void> {
  container.register<express.Router>(ROUTER_TOKENS.PARSER_RULE, {
    useFactory: () => express.Router(),
  });

  container.registerSingleton('IParserRuleRepository', ParserRuleRepositoryImpl);
  container.registerSingleton<ParserRuleService>(ParserRuleService);
  container.registerSingleton<ParserRuleController>(ParserRuleController);

}
