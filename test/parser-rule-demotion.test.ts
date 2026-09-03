import 'reflect-metadata';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ParserRuleService from '../src/modules/parser-rule/parser-rule.service';
import { IParserRuleRepository } from '../src/modules/parser-rule/parser-rule.repository';
import { IParserTemplateWithRules } from '../src/modules/parser-rule/parser-rule.interface';
import { RuleStatusEnum } from '../src/modules/parser-rule/parser-rule.enum';

function makeTemplate(overrides: Partial<IParserTemplateWithRules> = {}): IParserTemplateWithRules {
  return {
    id: 1,
    bankId: 2,
    version: 1,
    description: null,
    emailSubjectPattern: null,
    formatSignature: null,
    status: RuleStatusEnum.PRODUCTION,
    confidenceScore: 0.9,
    matchCount: 50,
    failCount: 0,
    recentFailStreak: 0,
    lastFailedAt: null,
    auditNotes: null,
    auditPassedAt: null,
    promotedAt: null,
    deprecatedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    rules: [],
    ...overrides,
  };
}

// Only the methods recordMatch/recordFailure/bulkReauditFailed actually touch
// are implemented for real; everything else on the interface throws if called,
// so an unexpected dependency surfaces immediately as a test failure.
class FakeParserRuleRepository implements Partial<IParserRuleRepository> {
  template: IParserTemplateWithRules;
  statusUpdates: { id: number; status: RuleStatusEnum; notes?: string }[] = [];

  constructor(template: IParserTemplateWithRules) {
    this.template = template;
  }

  async findTemplateById(id: number): Promise<IParserTemplateWithRules | null> {
    return this.template.id === id ? this.template : null;
  }

  async updateTemplateConfidence(id: number, matchCount: number, failCount: number): Promise<void> {
    this.template = { ...this.template, matchCount, failCount };
  }

  async updateTemplateLastFailed(): Promise<void> {
    this.template = { ...this.template, lastFailedAt: new Date() };
  }

  async updateRecentFailStreak(id: number, streak: number): Promise<void> {
    this.template = { ...this.template, recentFailStreak: streak };
  }

  async updateTemplateStatus(id: number, status: RuleStatusEnum, notes?: string): Promise<void> {
    this.statusUpdates.push({ id, status, notes });
    this.template = { ...this.template, status };
  }
}

function makeService(template: IParserTemplateWithRules) {
  const repository = new FakeParserRuleRepository(template);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new ParserRuleService(repository as any, {} as any);
  return { service, repository };
}

describe('rolling fail-streak demotion', () => {
  test('demotes after REGEX_ROLLING_DEMOTION_FAIL_STREAK consecutive failures, even with a healthy lifetime score', async () => {
    // matchCount=50 means the lifetime-average check alone would need dozens
    // more failures to trip - this isolates the rolling-streak path.
    const template = makeTemplate({ matchCount: 50, failCount: 0, recentFailStreak: 0 });
    const { service, repository } = makeService(template);

    for (let i = 0; i < 4; i++) {
      await service.recordFailure(1);
      assert.equal(repository.template.status, RuleStatusEnum.PRODUCTION, `should not demote before the streak threshold (failure ${i + 1})`);
    }

    await service.recordFailure(1);
    assert.equal(repository.template.status, RuleStatusEnum.CANDIDATE);
    assert.equal(repository.template.recentFailStreak, 5);

    const lifetimeScore = repository.template.matchCount / (repository.template.matchCount + repository.template.failCount * 2);
    assert.ok(lifetimeScore > 0.8, 'lifetime score should still be healthy - demotion was from the streak, not the lifetime average');
  });

  test('recordMatch resets the fail streak to 0', async () => {
    const template = makeTemplate({ recentFailStreak: 3 });
    const { service, repository } = makeService(template);

    await service.recordMatch(1);

    assert.equal(repository.template.recentFailStreak, 0);
  });

  test('recordMatch does not write when the streak is already 0', async () => {
    const template = makeTemplate({ recentFailStreak: 0 });
    const { service, repository } = makeService(template);
    let streakWriteCalls = 0;
    const originalUpdate = repository.updateRecentFailStreak.bind(repository);
    repository.updateRecentFailStreak = async (id, streak) => {
      streakWriteCalls++;
      return originalUpdate(id, streak);
    };

    await service.recordMatch(1);

    assert.equal(streakWriteCalls, 0);
  });

  test('a single failure does not demote a fresh template', async () => {
    const template = makeTemplate({ matchCount: 0, failCount: 0, recentFailStreak: 0, status: RuleStatusEnum.PRODUCTION });
    const { service, repository } = makeService(template);

    await service.recordFailure(1);

    assert.equal(repository.template.status, RuleStatusEnum.PRODUCTION);
    assert.equal(repository.template.recentFailStreak, 1);
  });
});
