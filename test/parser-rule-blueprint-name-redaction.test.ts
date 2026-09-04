import 'reflect-metadata';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ParserRuleService from '../src/modules/parser-rule/parser-rule.service';
import { IParserRuleRepository } from '../src/modules/parser-rule/parser-rule.repository';
import { IBankEmailBlueprint } from '../src/modules/parser-rule/parser-rule.interface';

class FakeParserRuleRepository implements Partial<IParserRuleRepository> {
  rows: IBankEmailBlueprint[] = [];
  private nextId = 1;

  async findBlueprintByBankTypeAndSignature(): Promise<IBankEmailBlueprint | null> {
    return null;
  }

  async findBlueprintsByBankAndType(): Promise<IBankEmailBlueprint[]> {
    return [];
  }

  async createBlueprint(data: Partial<IBankEmailBlueprint>): Promise<IBankEmailBlueprint> {
    const row: IBankEmailBlueprint = {
      id: this.nextId++,
      bankId: data.bankId!,
      transactionType: data.transactionType!,
      sanitizedSubject: data.sanitizedSubject!,
      sanitizedBody: data.sanitizedBody!,
      formatSignature: data.formatSignature!,
      sampleCount: data.sampleCount ?? 1,
      driftCount: 0,
      failed: data.failed ?? false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.rows.push(row);
    return row;
  }

  async updateBlueprint(id: number, data: Partial<IBankEmailBlueprint>): Promise<IBankEmailBlueprint> {
    const idx = this.rows.findIndex((r) => r.id === id);
    this.rows[idx] = { ...this.rows[idx], ...data, updatedAt: new Date() };
    return this.rows[idx];
  }

  async deleteBlueprint(id: number): Promise<void> {
    this.rows = this.rows.filter((r) => r.id !== id);
  }
}

function makeService() {
  const repository = new FakeParserRuleRepository();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new ParserRuleService(repository as any, {} as any);
  return { service, repository };
}

describe('sanitizeBlueprintText redacts person names (fintrack-backend#155)', () => {
  test('the real production narration shape is redacted: "Transfer to <masked> NAME NAME"', async () => {
    const { service, repository } = makeService();
    const body = 'Customer Transfer to 254741***761 SAMUEL MUNGAI\nAmount: KES 500.00';

    await service.captureBlueprint(3, 'debit', 'M-PESA alert', body);

    const stored = repository.rows[0].sanitizedBody;
    assert.ok(!stored.includes('SAMUEL'), `expected name redacted, got: ${stored}`);
    assert.ok(!stored.includes('MUNGAI'), `expected name redacted, got: ${stored}`);
    assert.match(stored, /Transfer to 254741\*\*\*761 <NAME>/);
  });

  test('a labeled "Beneficiary Name" field is redacted regardless of case', async () => {
    const { service, repository } = makeService();
    const body = 'Beneficiary Name: John Doe\nAmount: NGN 1,000.00';

    await service.captureBlueprint(2, 'credit', 'Alert', body);

    const stored = repository.rows[0].sanitizedBody;
    assert.ok(!stored.includes('John'), `expected name redacted, got: ${stored}`);
    assert.ok(!stored.includes('Doe'), `expected name redacted, got: ${stored}`);
    assert.match(stored, /<NAME>/);
  });

  test('a lone ALL-CAPS word with no name-indicating context is left untouched', async () => {
    const { service, repository } = makeService();
    const body = 'YOUR ACCOUNT HAS BEEN DEBITED\nNGN 5,000.00\nDescription: POS PURCHASE';

    await service.captureBlueprint(2, 'debit', 'AccessAlert', body);

    const stored = repository.rows[0].sanitizedBody;
    assert.ok(stored.includes('DEBITED'), `unrelated caps text should survive untouched, got: ${stored}`);
    assert.ok(!stored.includes('<NAME>'), `no name-indicating context should mean no redaction, got: ${stored}`);
  });
});
