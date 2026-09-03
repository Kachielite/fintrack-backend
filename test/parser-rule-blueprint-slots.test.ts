import 'reflect-metadata';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ParserRuleService from '../src/modules/parser-rule/parser-rule.service';
import { IParserRuleRepository } from '../src/modules/parser-rule/parser-rule.repository';
import { IBankEmailBlueprint } from '../src/modules/parser-rule/parser-rule.interface';

class FakeParserRuleRepository implements Partial<IParserRuleRepository> {
  rows: IBankEmailBlueprint[] = [];
  private nextId = 1;

  async findBlueprintByBankTypeAndSignature(
    bankId: number,
    transactionType: string,
    formatSignature: string,
  ): Promise<IBankEmailBlueprint | null> {
    return (
      this.rows.find(
        (r) => r.bankId === bankId && r.transactionType === transactionType && r.formatSignature === formatSignature,
      ) ?? null
    );
  }

  async findBlueprintsByBankAndType(bankId: number, transactionType: string): Promise<IBankEmailBlueprint[]> {
    return this.rows.filter((r) => r.bankId === bankId && r.transactionType === transactionType);
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

// Two structurally different Access Bank "debit" email shapes - a plain NGN
// debit alert and an FX/currency-conversion debit alert - matching what was
// found in production (fintrack-backend#184).
const PLAIN_DEBIT_SUBJECT = 'AccessAlert Transaction Alert [Debit: 5,000.00 NGN]';
const PLAIN_DEBIT_BODY = 'YOUR ACCOUNT HAS BEEN DEBITED\nNGN 5,000.00\nDescription: POS PURCHASE';
const FX_DEBIT_SUBJECT = 'AccessAlert Transaction Alert [Debit: 100.00 USD]';
const FX_DEBIT_BODY = 'FCY Conversion\nExchange Rate: 1500\nDebit Amount: 100.00\nCredit Amount: 150000.00';

describe('captureBlueprint per-format slots (fintrack-backend#184)', () => {
  test('a brand new bucket gets a single new slot', async () => {
    const { service, repository } = makeService();

    await service.captureBlueprint(2, 'debit', PLAIN_DEBIT_SUBJECT, PLAIN_DEBIT_BODY);

    assert.equal(repository.rows.length, 1);
    assert.equal(repository.rows[0].sampleCount, 1);
  });

  test('the same format arriving again updates the existing slot instead of creating a new one', async () => {
    const { service, repository } = makeService();

    await service.captureBlueprint(2, 'debit', PLAIN_DEBIT_SUBJECT, PLAIN_DEBIT_BODY);
    await service.captureBlueprint(2, 'debit', PLAIN_DEBIT_SUBJECT, PLAIN_DEBIT_BODY);
    await service.captureBlueprint(2, 'debit', PLAIN_DEBIT_SUBJECT, PLAIN_DEBIT_BODY);

    assert.equal(repository.rows.length, 1);
    assert.equal(repository.rows[0].sampleCount, 3);
  });

  test('a genuinely different format in the same bucket gets its own independent slot, not a replacement', async () => {
    const { service, repository } = makeService();

    await service.captureBlueprint(2, 'debit', PLAIN_DEBIT_SUBJECT, PLAIN_DEBIT_BODY);
    await service.captureBlueprint(2, 'debit', FX_DEBIT_SUBJECT, FX_DEBIT_BODY);

    assert.equal(repository.rows.length, 2, 'both formats should coexist as separate rows');
  });

  test('regression: alternating between two formats accumulates both independently instead of resetting each other', async () => {
    const { service, repository } = makeService();

    // This exact alternation pattern used to wipe the shared row on every
    // second differing sample under the old drift-replace threshold of 2.
    for (let i = 0; i < 5; i++) {
      await service.captureBlueprint(2, 'debit', PLAIN_DEBIT_SUBJECT, PLAIN_DEBIT_BODY);
      await service.captureBlueprint(2, 'debit', FX_DEBIT_SUBJECT, FX_DEBIT_BODY);
    }

    assert.equal(repository.rows.length, 2, 'still exactly two slots - one per format');
    const plain = repository.rows.find((r) => r.formatSignature === repository.rows[0].formatSignature)!;
    for (const row of repository.rows) {
      assert.equal(row.sampleCount, 5, `slot for ${row.sanitizedSubject} should have accumulated all 5 of its own samples`);
    }
    assert.ok(plain);
  });

  test('exceeding the per-bucket slot cap evicts the least-recently-updated slot before creating a new one', async () => {
    const { service, repository } = makeService();

    // buildFormatSignature strips digits from the subject and hashes the
    // body's colon-labeled fields, so each variant needs a genuinely
    // different label word (not just a different number) to land on a
    // distinct signature and therefore its own slot.
    const labelWords = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India'];

    // Fill the bucket to its cap with 8 genuinely distinct formats.
    for (const word of labelWords.slice(0, 8)) {
      await service.captureBlueprint(2, 'debit', `${word} Subject`, `${word} Label: value`);
    }
    assert.equal(repository.rows.length, 8);
    const survivingIds = repository.rows.slice(1).map((r) => r.id);
    const oldestId = repository.rows[0].id;

    // A 9th distinct format should evict the oldest (index 0, never touched
    // again since) rather than growing past the cap.
    await service.captureBlueprint(2, 'debit', `${labelWords[8]} Subject`, `${labelWords[8]} Label: value`);

    assert.equal(repository.rows.length, 8, 'bucket stays at the cap');
    assert.ok(!repository.rows.some((r) => r.id === oldestId), 'the least-recently-updated slot was evicted');
    for (const id of survivingIds) {
      assert.ok(repository.rows.some((r) => r.id === id), 'the other, more recently touched slots survive');
    }
  });
});
