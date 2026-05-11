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
import { IAiUsageRepository } from '@/modules/admin/admin.repository';

export interface IdentifiedBank {
  name: string;
  shortCode: string;
  country: string;
}

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
  extractTransaction(
    bankName: string,
    emailBody: string,
    emailSubject: string,
  ): Promise<ParsedTransaction | null>;
  generateTemplate(
    bankId: number,
    emailBody: string,
    emailSubject: string,
  ): Promise<IParserTemplate>;
  identifyBank(
    senderEmail: string,
    emailSubject: string,
    emailBody: string,
  ): Promise<IdentifiedBank | null>;
  recordMatch(templateId: number): Promise<void>;
  recordFailure(templateId: number): Promise<void>;
}

@injectable()
class ParserRuleService implements IParserRuleService {
  private openai: OpenAI;

  constructor(
    @inject('IParserRuleRepository') private repository: IParserRuleRepository,
    @inject('IAiUsageRepository') private aiUsageRepository: IAiUsageRepository,
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
        model: CONSTANTS.OPENAI_MODEL_AUDIT,
        messages: [
          {
            role: 'system',
            content:
              'You are an expert in JavaScript regex patterns for financial email parsing. Return JSON only.',
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

      if (response.usage) {
        this.aiUsageRepository.log({
          operation: 'audit_template',
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
          modelUsed: CONSTANTS.OPENAI_MODEL,
          templateId: templateId,
        }).catch(() => null);
      }

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
        if (template.emailSubjectPattern) {
          try {
            if (!new RegExp(template.emailSubjectPattern, 'i').test(emailSubject)) continue;
          } catch {
            continue;
          }
        }

        const result: ParsedTransaction = {};
        let allMatched = true;

        for (const rule of template.rules) {
          try {
            const { pattern, flags } = this.sanitizePattern(rule.pattern, rule.flags);
            const regex = new RegExp(pattern, flags);
            const match = regex.exec(emailBody);
            if (match && match[rule.extractGroup]) {
              const value = match[rule.extractGroup].trim();
              (result as any)[rule.field] = this.parseFieldValue(rule.field as RuleFieldEnum, value);
            } else {
              allMatched = false;
            }
          } catch (ruleErr) {
            logger.warn(`Skipping bad regex rule ${rule.id} for bank ${bankId}: ${ruleErr}`);
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

  async extractTransaction(
    bankName: string,
    emailBody: string,
    emailSubject: string,
  ): Promise<ParsedTransaction | null> {
    try {
      const response = await this.openai.chat.completions.create({
        model: CONSTANTS.OPENAI_MODEL_EXTRACTION,
        messages: [
          {
            role: 'system',
            content: 'You are a financial data extractor. Extract transaction details from bank notification emails. Return JSON only.',
          },
          {
            role: 'user',
            content: `Bank: ${bankName}
Subject: ${emailSubject}
Body:
${emailBody.substring(0, 2000)}

Extract the transaction details and return JSON:
{
  "is_transaction": true,
  "amount": <positive number, no symbols or commas>,
  "currency": "<ISO 4217 code, e.g. NGN, USD, GBP>",
  "merchant": "<merchant or recipient name, or null>",
  "transaction_type": "debit" or "credit",
  "balance": <account balance number if present, else null>,
  "reference": "<transaction ref if present, else null>"
}

If this is not a transaction notification, return { "is_transaction": false }.
Only include fields that are clearly present in the email.`,
          },
        ],
        response_format: { type: 'json_object' },
      });

      if (response.usage) {
        this.aiUsageRepository.log({
          operation: 'extract_transaction',
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
          modelUsed: CONSTANTS.OPENAI_MODEL_EXTRACTION,
        }).catch(() => null);
      }

      const raw = JSON.parse(response.choices[0].message.content || '{}');
      if (!raw.is_transaction) return null;

      const result: ParsedTransaction = {};
      if (raw.amount != null) result.amount = Number(raw.amount);
      if (raw.currency) result.currency = raw.currency;
      if (raw.merchant) result.merchant = raw.merchant;
      if (raw.transaction_type) result.transactionType = raw.transaction_type;
      if (raw.balance != null) result.balance = Number(raw.balance);
      if (raw.reference) result.reference = raw.reference;
      return result;
    } catch (error) {
      logger.error(`Error extracting transaction for bank ${bankName} - ${error}`);
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
        model: CONSTANTS.OPENAI_MODEL_TEMPLATE,
        messages: [
          {
            role: 'system',
            content:
              'You are an expert at writing JavaScript regex patterns for parsing bank notification emails. Return JSON only.',
          },
          {
            role: 'user',
            content: `Analyze this bank email and create JavaScript regex patterns to extract transaction data.

Subject: ${emailSubject}
Body:
${emailBody.substring(0, 3000)}

IMPORTANT: Use JavaScript regex syntax only.
- Do NOT use inline flags like (?i), (?m) — these are not supported in JavaScript.
- Put flags in the "flags" field instead (e.g. "flags": "i" for case-insensitive).
- Each pattern must have exactly one capture group for the value to extract.

Fields to extract (only include fields actually present in the email):
- amount: the transaction amount as a number string (e.g. "5,000.00")
- currency: the currency code or symbol (e.g. "NGN", "₦")
- merchant: merchant or recipient name
- transaction_type: "debit" or "credit"
- balance: account balance after transaction
- reference: transaction reference number

Return JSON:
{
  "description": "short description of this email format",
  "subject_pattern": "optional regex to match this email subject (no inline flags)",
  "fields": {
    "amount": { "pattern": "regex with one capture group", "flags": "i" },
    "currency": { "pattern": "regex with one capture group", "flags": "i" }
  }
}`,
          },
        ],
        response_format: { type: 'json_object' },
      });

      if (response.usage) {
        this.aiUsageRepository.log({
          operation: 'generate_template',
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
          modelUsed: CONSTANTS.OPENAI_MODEL_TEMPLATE,
        }).catch(() => null);
      }

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

  async identifyBank(
    senderEmail: string,
    emailSubject: string,
    emailBody: string,
  ): Promise<IdentifiedBank | null> {
    try {
      const response = await this.openai.chat.completions.create({
        model: CONSTANTS.OPENAI_MODEL_CLASSIFY,
        messages: [
          {
            role: 'system',
            content: 'You are classifying whether an email is a bank transaction notification. Return JSON only.',
          },
          {
            role: 'user',
            content: `Sender: ${senderEmail}
Subject: ${emailSubject}
Body (first 600 chars): ${emailBody.substring(0, 600)}

Is this a bank transaction notification email? If yes, identify the bank.
Return: { "is_bank": true, "bank_name": "Full Name", "short_code": "lowercase_id", "country": "ISO2" }
If not a bank email, return: { "is_bank": false }

short_code: lowercase alphanumeric slug (e.g. "gtbank", "access", "zenith").
country: ISO 3166-1 alpha-2 (e.g. "NG", "GB", "US").`,
          },
        ],
        response_format: { type: 'json_object' },
      });

      if (response.usage) {
        this.aiUsageRepository.log({
          operation: 'identify_bank',
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
          modelUsed: CONSTANTS.OPENAI_MODEL,
        }).catch(() => null);
      }

      const raw = JSON.parse(response.choices[0].message.content || '{}');
      if (!raw.is_bank) return null;
      return { name: raw.bank_name, shortCode: raw.short_code, country: raw.country };
    } catch (error) {
      logger.error(`Error identifying bank from email ${senderEmail} - ${error}`);
      return null;
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

  private sanitizePattern(pattern: string, flags: string): { pattern: string; flags: string } {
    // Strip Python-style inline flags like (?i), (?m), (?s) — not valid in JS
    const inlineMatch = pattern.match(/^\(\?([a-z]+)\)/i);
    if (inlineMatch) {
      pattern = pattern.slice(inlineMatch[0].length);
      for (const flag of inlineMatch[1]) {
        if ('gimsuy'.includes(flag) && !flags.includes(flag)) flags += flag;
      }
    }
    return { pattern, flags };
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
