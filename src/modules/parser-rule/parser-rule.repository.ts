import { inject, injectable } from 'tsyringe';
import { and, eq, inArray } from 'drizzle-orm';
import Database from '@/common/lib/database';
import {
  BankEmailBlueprintSchema,
  ParserRuleSchema,
  ParserTemplateSchema,
  TemplateRuleSchema,
} from './parser-rule.schema';
import {
  IBankEmailBlueprint,
  IParserRule,
  IParserTemplate,
  IParserTemplateWithRules,
} from './parser-rule.interface';
import { RuleStatusEnum } from './parser-rule.enum';

export interface IParserRuleRepository {
  createTemplate(data: Partial<IParserTemplate>): Promise<IParserTemplate>;
  createRule(data: Partial<IParserRule>): Promise<IParserRule>;
  linkRuleToTemplate(templateId: number, ruleId: number): Promise<void>;
  findProductionTemplatesByBank(bankId: number): Promise<IParserTemplateWithRules[]>;
  findTemplateById(id: number): Promise<IParserTemplateWithRules | null>;
  findAllTemplates(): Promise<IParserTemplate[]>;
  findTemplatesByStatus(status: RuleStatusEnum): Promise<IParserTemplateWithRules[]>;
  updateTemplateStatus(id: number, status: RuleStatusEnum, notes?: string): Promise<void>;
  updateTemplateConfidence(id: number, matchCount: number, failCount: number): Promise<void>;
  updateTemplateLastFailed(id: number): Promise<void>;
  updateRuleStatus(id: number, status: RuleStatusEnum, notes?: string): Promise<void>;
  findBlueprintByBankAndType(bankId: number, transactionType: string): Promise<IBankEmailBlueprint | null>;
  findBlueprintsByBank(bankId: number): Promise<IBankEmailBlueprint[]>;
  createBlueprint(data: Partial<IBankEmailBlueprint>): Promise<IBankEmailBlueprint>;
  updateBlueprint(id: number, data: Partial<IBankEmailBlueprint>): Promise<IBankEmailBlueprint>;
}

@injectable()
class ParserRuleRepositoryImpl implements IParserRuleRepository {
  constructor(@inject(Database) private db: Database) {}

  async createTemplate(data: Partial<IParserTemplate>): Promise<IParserTemplate> {
    const [row] = await this.db.client
      .insert(ParserTemplateSchema)
      .values({
        bankId: data.bankId!,
        version: data.version || 1,
        description: data.description,
        emailSubjectPattern: data.emailSubjectPattern,
      })
      .returning();
    return row as IParserTemplate;
  }

  async createRule(data: Partial<IParserRule>): Promise<IParserRule> {
    const [row] = await this.db.client
      .insert(ParserRuleSchema)
      .values({
        bankId: data.bankId!,
        field: data.field!,
        pattern: data.pattern!,
        flags: data.flags || 'i',
        extractGroup: data.extractGroup || 1,
        createdBy: data.createdBy || 'ai',
      })
      .returning();
    return row as IParserRule;
  }

  async linkRuleToTemplate(templateId: number, ruleId: number): Promise<void> {
    await this.db.client.insert(TemplateRuleSchema).values({ templateId, ruleId });
  }

  async findProductionTemplatesByBank(bankId: number): Promise<IParserTemplateWithRules[]> {
    const templates = (await this.db.client
      .select()
      .from(ParserTemplateSchema)
      .where(
        and(
          eq(ParserTemplateSchema.bankId, bankId),
          eq(ParserTemplateSchema.status, RuleStatusEnum.PRODUCTION),
        ),
      )) as IParserTemplate[];

    return this.hydrateTemplates(templates);
  }

  async findTemplateById(id: number): Promise<IParserTemplateWithRules | null> {
    const templates = (await this.db.client
      .select()
      .from(ParserTemplateSchema)
      .where(eq(ParserTemplateSchema.id, id))
      .limit(1)) as IParserTemplate[];

    if (!templates[0]) return null;
    const hydrated = await this.hydrateTemplates(templates);
    return hydrated[0] ?? null;
  }

  async findAllTemplates(): Promise<IParserTemplate[]> {
    return (await this.db.client
      .select()
      .from(ParserTemplateSchema)
      .where(eq(ParserTemplateSchema.status, RuleStatusEnum.PRODUCTION))) as IParserTemplate[];
  }

  async findTemplatesByStatus(status: RuleStatusEnum): Promise<IParserTemplateWithRules[]> {
    const templates = (await this.db.client
      .select()
      .from(ParserTemplateSchema)
      .where(eq(ParserTemplateSchema.status, status))) as IParserTemplate[];
    return this.hydrateTemplates(templates);
  }

  async updateTemplateStatus(
    id: number,
    status: RuleStatusEnum,
    notes?: string,
  ): Promise<void> {
    const updateData: Record<string, unknown> = { status, updatedAt: new Date() };
    if (status === RuleStatusEnum.AUDITED) updateData.auditPassedAt = new Date();
    if (status === RuleStatusEnum.PRODUCTION) updateData.promotedAt = new Date();
    if (status === RuleStatusEnum.DEPRECATED) updateData.deprecatedAt = new Date();
    if (notes) updateData.auditNotes = notes;

    await this.db.client
      .update(ParserTemplateSchema)
      .set(updateData)
      .where(eq(ParserTemplateSchema.id, id));
  }

  async updateTemplateConfidence(
    id: number,
    matchCount: number,
    failCount: number,
  ): Promise<void> {
    const confidenceScore = matchCount / (matchCount + failCount * 2) || 0;
    await this.db.client
      .update(ParserTemplateSchema)
      .set({ matchCount, failCount, confidenceScore, updatedAt: new Date() })
      .where(eq(ParserTemplateSchema.id, id));
  }

  async updateTemplateLastFailed(id: number): Promise<void> {
    await this.db.client
      .update(ParserTemplateSchema)
      .set({ lastFailedAt: new Date(), updatedAt: new Date() })
      .where(eq(ParserTemplateSchema.id, id));
  }

  async updateRuleStatus(id: number, status: RuleStatusEnum, notes?: string): Promise<void> {
    const updateData: Record<string, unknown> = { status, updatedAt: new Date() };
    if (notes) updateData.auditNotes = notes;
    await this.db.client
      .update(ParserRuleSchema)
      .set(updateData)
      .where(eq(ParserRuleSchema.id, id));
  }

  async findBlueprintByBankAndType(
    bankId: number,
    transactionType: string,
  ): Promise<IBankEmailBlueprint | null> {
    const rows = await this.db.client
      .select()
      .from(BankEmailBlueprintSchema)
      .where(
        and(
          eq(BankEmailBlueprintSchema.bankId, bankId),
          eq(BankEmailBlueprintSchema.transactionType, transactionType),
        ),
      )
      .limit(1);
    return (rows[0] as IBankEmailBlueprint) ?? null;
  }

  async findBlueprintsByBank(bankId: number): Promise<IBankEmailBlueprint[]> {
    // Excludes failed captures — these come from extractions that didn't
    // produce a clean transaction, so they'd corrupt template generation/audit.
    const rows = await this.db.client
      .select()
      .from(BankEmailBlueprintSchema)
      .where(
        and(eq(BankEmailBlueprintSchema.bankId, bankId), eq(BankEmailBlueprintSchema.failed, false)),
      );
    return rows as IBankEmailBlueprint[];
  }

  async createBlueprint(data: Partial<IBankEmailBlueprint>): Promise<IBankEmailBlueprint> {
    const [row] = await this.db.client
      .insert(BankEmailBlueprintSchema)
      .values({
        bankId: data.bankId!,
        transactionType: data.transactionType!,
        sanitizedSubject: data.sanitizedSubject!,
        sanitizedBody: data.sanitizedBody!,
        formatSignature: data.formatSignature!,
        sampleCount: data.sampleCount ?? 1,
        driftCount: data.driftCount ?? 0,
        failed: data.failed ?? false,
      })
      .returning();
    return row as IBankEmailBlueprint;
  }

  async updateBlueprint(id: number, data: Partial<IBankEmailBlueprint>): Promise<IBankEmailBlueprint> {
    const [row] = await this.db.client
      .update(BankEmailBlueprintSchema)
      .set({
        sanitizedSubject: data.sanitizedSubject,
        sanitizedBody: data.sanitizedBody,
        formatSignature: data.formatSignature,
        sampleCount: data.sampleCount,
        driftCount: data.driftCount,
        failed: data.failed,
        updatedAt: new Date(),
      })
      .where(eq(BankEmailBlueprintSchema.id, id))
      .returning();
    return row as IBankEmailBlueprint;
  }

  private async hydrateTemplates(
    templates: IParserTemplate[],
  ): Promise<IParserTemplateWithRules[]> {
    if (templates.length === 0) return [];

    const templateIds = templates.map((t) => t.id);
    const junctions = await this.db.client
      .select()
      .from(TemplateRuleSchema)
      .where(inArray(TemplateRuleSchema.templateId, templateIds));

    const ruleIds = junctions.map((j) => j.ruleId);
    const rules =
      ruleIds.length > 0
        ? ((await this.db.client
            .select()
            .from(ParserRuleSchema)
            .where(inArray(ParserRuleSchema.id, ruleIds))) as IParserRule[])
        : [];

    const ruleMap = new Map<number, IParserRule[]>();
    for (const j of junctions) {
      const rule = rules.find((r) => r.id === j.ruleId);
      if (rule) {
        if (!ruleMap.has(j.templateId)) ruleMap.set(j.templateId, []);
        ruleMap.get(j.templateId)!.push(rule);
      }
    }

    return templates.map((t) => ({ ...t, rules: ruleMap.get(t.id) || [] }));
  }
}

export default ParserRuleRepositoryImpl;
