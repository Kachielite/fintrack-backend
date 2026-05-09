import { inject, injectable } from 'tsyringe';
import OpenAI from 'openai';
import { CONSTANTS } from '@/common/configuration/constants';
import { InternalServerException, ResourceNotFoundException } from '@/common/exception';
import logger from '@/common/lib/logger';
import { IParserRuleRepository } from './parser-rule.repository';
import {
  IParserTemplate,
  IParserTemplateWithRules,
  ParsedTransaction,
  AuditResult,
} from './parser-rule.interface';
import { ParserTemplateResponseDTO } from './parser-rule.dto';
import { RuleStatusEnum, RuleFieldEnum, RuleCreatorEnum } from './parser-rule.enum';

export interface IParserRuleService {
  listProductionTemplates(): Promise<ParserTemplateResponseDTO[]>;
  getTemplate(id: number): Promise<IParserTemplateWithRules>;
  auditTemplate(templateId: number): Promise<AuditResult>;
  promoteTemplate(id: number): Promise<ParserTemplateResponseDTO>;
  applyTemplate(
    bankId: number,
    emailBody: string,
    emailSubject: string,
  ): Promise<ParsedTransaction | null>;
  generateTemplate(
    bankId: number,
    emailBody: string,
    emailSubject: string,
  ): Promise<IParserTemplate>;
  recordMatch(templateId: number): Promise<void>;
  recordFailure(templateId: number): Promise<void>;
}

@injectable()
class ParserRuleService implements IParserRuleService {
  private openai: OpenAI;

  constructor(
    @inject('IParserRuleRepository') private repository: IParserRuleRepository,
  ) {
    this.openai = new OpenAI({ apiKey: CONSTANTS.OPENAI_API_KEY });
  }

  async listProductionTemplates(): Promise<ParserTemplateResponseDTO[]> {
    try {
      const templates = await this.repository.findAllTemplates();
      return templates.map((t) => this.mapToDTO(t));
    } catch (error) {
      logger.error(`Error listing templates - ${error}`);
      throw new InternalServerException('Failed to list parser templates');
    }
  }

  async getTemplate(id: number): Promise<IParserTemplateWithRules> {
    try {
      const template = await this.repository.findTemplateById(id);
      if (!template) throw new ResourceNotFoundException('Template not found');
      return template;
    } catch (error) {
      if (error instanceof ResourceNotFoundException) throw error;
      logger.error(`Error fetching template ${id} - ${error}`);
      throw new InternalServerException('Failed to fetch template');
    }
  }

  async auditTemplate(templateId: number): Promise<AuditResult> {
    try {
      const template = await this.repository.findTemplateById(templateId);
      if (!template) throw new ResourceNotFoundException('Template not found');

      const rulesJson = template.rules.map((r) => ({
        id: r.id,
        field: r.field,
        pattern: r.pattern,
        flags: r.flags,
      }));

      const response = await this.openai.chat.completions.create({
        model: CONSTANTS.OPENAI_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You are an expert in regex patterns for financial email parsing. Return JSON only.',
          },
          {
            role: 'user',
            content: `Audit the following regex rules for a bank email parser:
${JSON.stringify(rulesJson, null, 2)}

For each rule, assess:
1. Is it correct and captures the right group?
2. Is it robust to minor whitespace/formatting variations?
3. Is it too broad and might match false positives?

Return JSON only in this exact format:
{ "passed": boolean, "notes": string, "field_results": [{ "field": string, "passed": boolean, "concern": string }] }`,
          },
        ],
        response_format: { type: 'json_object' },
      });

      const raw = JSON.parse(response.choices[0].message.content || '{}');
      const result: AuditResult = {
        passed: raw.passed,
        notes: raw.notes,
        fieldResults: raw.field_results || [],
      };

      await this.repository.updateTemplateStatus(
        templateId,
        result.passed ? RuleStatusEnum.AUDITED : RuleStatusEnum.FAILED_AUDIT,
        result.notes,
      );

      if (result.passed) {
        await this.repository.updateTemplateStatus(templateId, RuleStatusEnum.PRODUCTION);
      }

      return result;
    } catch (error) {
      if (error instanceof ResourceNotFoundException) throw error;
      logger.error(`Error auditing template ${templateId} - ${error}`);
      throw new InternalServerException('Failed to audit template');
    }
  }

  async promoteTemplate(id: number): Promise<ParserTemplateResponseDTO> {
    try {
      const template = await this.repository.findTemplateById(id);
      if (!template) throw new ResourceNotFoundException('Template not found');
      if (template.status !== RuleStatusEnum.AUDITED) {
        throw new InternalServerException('Only audited templates can be promoted');
      }
      await this.repository.updateTemplateStatus(id, RuleStatusEnum.PRODUCTION);
      const updated = await this.repository.findTemplateById(id);
      return this.mapToDTO(updated!);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) throw error;
      logger.error(`Error promoting template ${id} - ${error}`);
      throw new InternalServerException('Failed to promote template');
    }
  }

  async applyTemplate(
    bankId: number,
    emailBody: string,
    emailSubject: string,
  ): Promise<ParsedTransaction | null> {
    try {
      const templates = await this.repository.findProductionTemplatesByBank(bankId);
      if (templates.length === 0) return null;

      for (const template of templates) {
        if (
          template.emailSubjectPattern &&
          !new RegExp(template.emailSubjectPattern, 'i').test(emailSubject)
        ) {
          continue;
        }

        const result: ParsedTransaction = {};
        let allMatched = true;

        for (const rule of template.rules) {
          const regex = new RegExp(rule.pattern, rule.flags);
          const match = regex.exec(emailBody);
          if (match && match[rule.extractGroup]) {
            const value = match[rule.extractGroup].trim();
            (result as any)[rule.field] = this.parseFieldValue(rule.field as RuleFieldEnum, value);
          } else {
            allMatched = false;
          }
        }

        if (allMatched && Object.keys(result).length > 0) {
          return result;
        }
      }
      return null;
    } catch (error) {
      logger.error(`Error applying template for bank ${bankId} - ${error}`);
      return null;
    }
  }

  async generateTemplate(
    bankId: number,
    emailBody: string,
    emailSubject: string,
  ): Promise<IParserTemplate> {
    try {
      const response = await this.openai.chat.completions.create({
        model: CONSTANTS.OPENAI_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You are an expert at extracting financial data from bank notification emails. Return JSON only.',
          },
          {
            role: 'user',
            content: `Analyze this bank email and create regex patterns to extract transaction data.

Subject: ${emailSubject}
Body: ${emailBody}

Return a JSON object with regex patterns for the fields present in this email.
Fields to look for: amount, currency, merchant, transaction_type (debit/credit), date, balance, reference

Format:
{
  "description": "short description of this email format",
  "subject_pattern": "optional regex to match this email subject",
  "fields": {
    "amount": { "pattern": "regex string with capture group", "flags": "i" },
    "currency": { "pattern": "regex string", "flags": "i" }
  }
}

Return JSON only. Only include fields actually present in the email.`,
          },
        ],
        response_format: { type: 'json_object' },
      });

      const raw = JSON.parse(response.choices[0].message.content || '{}');
      const template = await this.repository.createTemplate({
        bankId,
        description: raw.description,
        emailSubjectPattern: raw.subject_pattern,
      });

      for (const [field, ruleData] of Object.entries(raw.fields || {})) {
        const rd = ruleData as any;
        const rule = await this.repository.createRule({
          bankId,
          field: field as RuleFieldEnum,
          pattern: rd.pattern,
          flags: rd.flags || 'i',
          extractGroup: 1,
          createdBy: RuleCreatorEnum.AI,
        });
        await this.repository.linkRuleToTemplate(template.id, rule.id);
      }

      return template;
    } catch (error) {
      logger.error(`Error generating template for bank ${bankId} - ${error}`);
      throw new InternalServerException('Failed to generate parser template');
    }
  }

  async recordMatch(templateId: number): Promise<void> {
    try {
      const template = await this.repository.findTemplateById(templateId);
      if (!template) return;
      const newMatchCount = template.matchCount + 1;
      await this.repository.updateTemplateConfidence(templateId, newMatchCount, template.failCount);
    } catch (error) {
      logger.error(`Error recording match for template ${templateId} - ${error}`);
    }
  }

  async recordFailure(templateId: number): Promise<void> {
    try {
      const template = await this.repository.findTemplateById(templateId);
      if (!template) return;
      const newFailCount = template.failCount + 1;
      await this.repository.updateTemplateConfidence(templateId, template.matchCount, newFailCount);
      await this.repository.updateTemplateLastFailed(templateId);

      const newScore = template.matchCount / (template.matchCount + newFailCount * 2) || 0;
      if (newScore < CONSTANTS.REGEX_REAUDIT_THRESHOLD) {
        await this.repository.updateTemplateStatus(templateId, RuleStatusEnum.CANDIDATE, 'Score fell below reaudit threshold');
      }
    } catch (error) {
      logger.error(`Error recording failure for template ${templateId} - ${error}`);
    }
  }

  private parseFieldValue(field: RuleFieldEnum, value: string): string | number {
    if (field === RuleFieldEnum.AMOUNT || field === RuleFieldEnum.BALANCE) {
      return parseFloat(value.replace(/,/g, ''));
    }
    return value;
  }

  private mapToDTO(t: IParserTemplate): ParserTemplateResponseDTO {
    return {
      id: t.id,
      bank_id: t.bankId,
      version: t.version,
      description: t.description,
      status: t.status as any,
      confidence_score: t.confidenceScore,
      match_count: t.matchCount,
      fail_count: t.failCount,
    };
  }
}

export default ParserRuleService;
