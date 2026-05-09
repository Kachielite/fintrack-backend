import { inject, injectable } from 'tsyringe';
import { and, eq, inArray } from 'drizzle-orm';
import Database from '@/common/lib/database';
import { ParserRuleSchema, ParserTemplateSchema, TemplateRuleSchema } from './parser-rule.schema';
import {
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
  updateTemplateStatus(id: number, status: RuleStatusEnum, notes?: string): Promise<void>;
  updateTemplateConfidence(id: number, matchCount: number, failCount: number): Promise<void>;
  updateTemplateLastFailed(id: number): Promise<void>;
  updateRuleStatus(id: number, status: RuleStatusEnum, notes?: string): Promise<void>;
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
