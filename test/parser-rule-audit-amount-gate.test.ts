import 'reflect-metadata';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ParserRuleService from '../src/modules/parser-rule/parser-rule.service';
import { IParserRuleRepository } from '../src/modules/parser-rule/parser-rule.repository';
import { IParserTemplateWithRules, IBankEmailBlueprint, IParserRule } from '../src/modules/parser-rule/parser-rule.interface';
import { RuleStatusEnum, RuleFieldEnum, RuleCreatorEnum } from '../src/modules/parser-rule/parser-rule.enum';

function makeRule(overrides: Partial<IParserRule> = {}): IParserRule {
  return {
    id: 1,
    bankId: 2,
    version: 1,
    field: RuleFieldEnum.BALANCE,
    pattern: 'Balance\\s+([\\d.]+)',
    flags: 'i',
    extractGroup: 1,
    status: RuleStatusEnum.CANDIDATE,
    confidenceScore: 0,
    matchCount: 0,
    failCount: 0,
    createdBy: RuleCreatorEnum.AI,
    auditNotes: null,
    auditPassedAt: null,
    promotedAt: null,
    deprecatedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeTemplate(overrides: Partial<IParserTemplateWithRules> = {}): IParserTemplateWithRules {
  return {
    id: 1,
    bankId: 2,
    version: 1,
    description: null,
    emailSubjectPattern: null,
    formatSignature: null,
    status: RuleStatusEnum.CANDIDATE,
    confidenceScore: 0,
    matchCount: 0,
    failCount: 0,
    recentFailStreak: 0,
    lastFailedAt: null,
    auditNotes: null,
    auditPassedAt: null,
    promotedAt: null,
    deprecatedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    rules: [makeRule()],
    ...overrides,
  };
}

function makeBlueprint(overrides: Partial<IBankEmailBlueprint> = {}): IBankEmailBlueprint {
  return {
    id: 1,
    bankId: 2,
    transactionType: 'debit',
    sanitizedSubject: 'Transaction Alert',
    sanitizedBody: 'Balance 100.00',
    formatSignature: 'sig',
    sampleCount: 5,
    driftCount: 0,
    failed: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

class FakeParserRuleRepository implements Partial<IParserRuleRepository> {
  template: IParserTemplateWithRules;
  blueprints: IBankEmailBlueprint[];
  statusUpdates: { id: number; status: RuleStatusEnum; notes?: string }[] = [];

  constructor(template: IParserTemplateWithRules, blueprints: IBankEmailBlueprint[]) {
    this.template = template;
    this.blueprints = blueprints;
  }

  async findTemplateById(id: number): Promise<IParserTemplateWithRules | null> {
    return this.template.id === id ? this.template : null;
  }

  async findBlueprintsByBank(): Promise<IBankEmailBlueprint[]> {
    return this.blueprints;
  }

  async updateTemplateStatus(id: number, status: RuleStatusEnum, notes?: string): Promise<void> {
    this.statusUpdates.push({ id, status, notes });
    this.template = { ...this.template, status };
  }
}

function makeService(template: IParserTemplateWithRules, blueprints: IBankEmailBlueprint[]) {
  const repository = new FakeParserRuleRepository(template, blueprints);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new ParserRuleService(repository as any, {} as any);
  return { service, repository };
}

// The OpenAI client is constructed internally by the service rather than
// injected, so tests reach into the instance to stub the one call site
// auditTemplate uses - this also lets a test assert the call never happened,
// which is the whole point of the amount-coverage short-circuit.
function stubOpenAiCreate(service: ParserRuleService, impl: () => unknown) {
  let calls = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (service as any).openai = {
    chat: {
      completions: {
        create: async () => {
          calls++;
          return impl();
        },
      },
    },
  };
  return { callCount: () => calls };
}

describe('auditTemplate amount-coverage gate (fintrack-backend#183)', () => {
  test('fails without calling the LLM when the template has no amount rule at all', async () => {
    const template = makeTemplate({ rules: [makeRule({ field: RuleFieldEnum.BALANCE, pattern: 'Balance\\s+([\\d.]+)' })] });
    const blueprint = makeBlueprint({ sanitizedBody: 'Balance 100.00' });
    const { service, repository } = makeService(template, [blueprint]);
    const openai = stubOpenAiCreate(service, () => {
      throw new Error('LLM should not be called when there is no amount rule');
    });

    const result = await service.auditTemplate(1);

    assert.equal(result.passed, false);
    assert.equal(openai.callCount(), 0);
    assert.equal(repository.template.status, RuleStatusEnum.FAILED_AUDIT);
  });

  test('fails without calling the LLM when the amount rule exists but never matches real blueprint text', async () => {
    const template = makeTemplate({
      rules: [makeRule({ field: RuleFieldEnum.AMOUNT, pattern: 'Amount\\s+([\\d.]+)' })],
    });
    const blueprint = makeBlueprint({ sanitizedBody: 'Balance 100.00' }); // no "Amount" label present
    const { service, repository } = makeService(template, [blueprint]);
    const openai = stubOpenAiCreate(service, () => {
      throw new Error('LLM should not be called when amount never actually matched');
    });

    const result = await service.auditTemplate(1);

    assert.equal(result.passed, false);
    assert.equal(openai.callCount(), 0);
    assert.equal(repository.template.status, RuleStatusEnum.FAILED_AUDIT);
  });

  test('still promotes via the LLM judge when amount genuinely matched (regression: happy path unaffected)', async () => {
    const template = makeTemplate({
      rules: [makeRule({ id: 2, field: RuleFieldEnum.AMOUNT, pattern: 'Amount\\s+([\\d.]+)' })],
    });
    const blueprint = makeBlueprint({ sanitizedBody: 'Amount 250.00' });
    const { service, repository } = makeService(template, [blueprint]);
    const openai = stubOpenAiCreate(service, () => ({
      choices: [{ message: { content: JSON.stringify({ passed: true, notes: 'looks good', field_results: [] }) } }],
    }));

    const result = await service.auditTemplate(1);

    assert.equal(result.passed, true);
    assert.equal(openai.callCount(), 1);
    assert.equal(repository.template.status, RuleStatusEnum.PRODUCTION);
  });
});
