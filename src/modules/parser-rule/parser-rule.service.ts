import { inject, injectable } from 'tsyringe';
import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import { CONSTANTS } from '@/common/configuration/constants';
import { InternalServerException, ResourceNotFoundException } from '@/common/exception';
import logger from '@/common/lib/logger';
import { IParserRuleRepository } from './parser-rule.repository';
import {
  IParserTemplate,
  IParserTemplateWithRules,
  ParsedTransaction,
  TemplateParseResult,
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
  ): Promise<TemplateParseResult | null>;
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
  captureBlueprint(
    bankId: number,
    transactionType: 'debit' | 'credit',
    emailSubject: string,
    emailBody: string,
  ): Promise<void>;
  recordMatch(templateId: number): Promise<void>;
  recordFailure(templateId: number): Promise<void>;
}

const BLUEPRINT_BODY_MAX_LEN = 3000;
const BLUEPRINT_SUBJECT_MAX_LEN = 240;
const BLUEPRINT_DRIFT_REPLACE_THRESHOLD = 2;

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
      const blueprintContext = await this.getBlueprintContext(template.bankId);

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

Known bank blueprint samples (sanitized):
${blueprintContext}

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
          modelUsed: CONSTANTS.OPENAI_MODEL_AUDIT,
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
      if (this.isRateLimitError(error)) {
        logger.warn(`Rate-limited while auditing template ${templateId}`);
        throw new InternalServerException('OpenAI rate limit reached while auditing template');
      }
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
  ): Promise<TemplateParseResult | null> {
    try {
      const templates = await this.repository.findProductionTemplatesByBank(bankId);
      if (templates.length === 0) return null;

      let bestMatch: { templateId: number; parsed: ParsedTransaction; score: number; matchedCount: number } | null = null;

      for (const template of templates) {
        if (template.emailSubjectPattern) {
          try {
            if (!new RegExp(template.emailSubjectPattern, 'i').test(emailSubject)) continue;
          } catch {
            continue;
          }
        }

        const result: ParsedTransaction = {};
        let matchedCount = 0;
        let requiredMatched = false;

        for (const rule of template.rules) {
          try {
            const { pattern, flags } = this.sanitizePattern(rule.pattern, rule.flags);
            const regex = new RegExp(pattern, flags);
            const match = regex.exec(emailBody);
            if (match && match[rule.extractGroup]) {
              const value = match[rule.extractGroup].trim();
              this.assignParsedField(
                result,
                rule.field as RuleFieldEnum,
                this.parseFieldValue(rule.field as RuleFieldEnum, value),
              );
              matchedCount++;
              if (rule.field === RuleFieldEnum.AMOUNT) requiredMatched = true;
            }
          } catch (ruleErr) {
            logger.warn(`Skipping bad regex rule ${rule.id} for bank ${bankId}: ${ruleErr}`);
          }
        }

        const minMatched = template.rules.length <= 1 ? 1 : 2;
        if (!requiredMatched || matchedCount < minMatched || Object.keys(result).length === 0) {
          continue;
        }

        const score = matchedCount / Math.max(template.rules.length, 1);
        if (!bestMatch || score > bestMatch.score || (score === bestMatch.score && matchedCount > bestMatch.matchedCount)) {
          bestMatch = {
            templateId: template.id,
            parsed: result,
            score,
            matchedCount,
          };
        }
      }

      if (!bestMatch) return null;
      return {
        templateId: bestMatch.templateId,
        parsed: bestMatch.parsed,
      };
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
            content: `You are a financial data extractor. Extract transaction details from bank notification emails. Return JSON only.

NON-TRANSACTION EMAILS — return { "is_transaction": false } immediately if the email is:
- A satisfaction/feedback survey ("How did you feel about this service?", "Rate your experience", "How was your visit?", "kindly rate", "share your feedback")
- A marketing or promotional offer
- An OTP or security verification code
- An account statement summary (not a single transaction alert)
- An unsubscribe confirmation or privacy notice

IMPORTANT TRANSACTION SIGNALS — treat as transaction when present:
- "Transaction Notification"
- "Debit alert details" or "Credit transaction occurred"
- Fields such as Amount, Current/Available Balance, Description, Transaction Reference, Value Date, Time of Transaction
- Bank formats from Stanbic IBTC, GTBank GeNS, Access Bank and similar

MERCHANT NAME RULES — clean up raw payment processor strings:
- Strip prefixes: "PWL*", "WEB PYMT ", "PADDLE.NET* ", "PAYPAL *", "POS ", "ATM "
- Strip location suffixes like " NAIROBI KE", " LAGOS NG", " LONDON GB", " ACCRA GH"
- Strip account/tracking IDs: trailing patterns like "_ZUFPAN177702590" or " *XF82KQPW"
- Examples: "PWL*GLOVO NAIROBI KE" → "Glovo"; "SPOTIFY_ZUFPAN177702590" → "Spotify"; "WEB PYMT PADDLE.NET* ENHANCV LONDON GB" → "Enhancv"

CATEGORY CLASSIFICATION — pick one:
- peer_to_peer_transfer
- business_payment
- subscriptions
- entertainment_leisure
- mobile_internet
- utilities
- groceries
- retail_ecommerce
- dining_food_delivery
- transport
- fuel_auto
- travel
- bank_charges
- currency_conversion
- salary_wages
- refunds_reimbursements
- healthcare
- education
- charity_donations
- cash_withdrawal
- uncategorized

Rules:
- use salary_wages for salary/payroll/interest-style credit inflows from bank narration
- use refunds_reimbursements for refund/reversal/cashback credits
- use peer_to_peer_transfer only for person-to-person transfer narration`,
          },
          {
            role: 'user',
            content: `Bank: ${bankName}
Subject: ${emailSubject}
Body:
${emailBody.substring(0, 2500)}

Return JSON:
{
  "is_transaction": true,
  "amount": <positive number, no currency symbols or commas>,
  "currency": "<ISO 4217 code, e.g. NGN, USD, GBP, KES>",
  "merchant": "<clean merchant or recipient name>",
  "transaction_type": "debit" | "credit",
  "category": "peer_to_peer_transfer" | "business_payment" | "subscriptions" | "entertainment_leisure" | "mobile_internet" | "utilities" | "groceries" | "retail_ecommerce" | "dining_food_delivery" | "transport" | "fuel_auto" | "travel" | "bank_charges" | "currency_conversion" | "salary_wages" | "refunds_reimbursements" | "healthcare" | "education" | "charity_donations" | "cash_withdrawal" | "uncategorized",
  "transaction_date": "<transaction datetime in ISO 8601 (YYYY-MM-DDTHH:mm:ss) when available; otherwise YYYY-MM-DD; null if not found>",
  "balance": <account balance number after transaction, or null>,
  "reference": "<transaction reference/ID if present, else null>"
}

If this is not a transaction notification, return { "is_transaction": false }.`,
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
      if (raw.category) result.category = raw.category;
      if (raw.transaction_date) result.date = raw.transaction_date;
      if (raw.balance != null) result.balance = Number(raw.balance);
      if (raw.reference) result.reference = raw.reference;
      return result;
    } catch (error) {
      if (this.isRateLimitError(error)) {
        logger.warn(`Rate-limited while extracting transaction for bank ${bankName}`);
        return null;
      }
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
      const blueprintContext = await this.getBlueprintContext(bankId);
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

Known bank blueprint samples (sanitized):
${blueprintContext}

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
      if (this.isRateLimitError(error)) {
        logger.warn(`Rate-limited while generating template for bank ${bankId}`);
        throw new InternalServerException('OpenAI rate limit reached while generating template');
      }
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

Rules:
- Treat sender domain as the strongest signal of bank identity (e.g. *@stanbicibtc.com => Stanbic IBTC).
- Do not infer another bank from body wording if sender domain strongly indicates a different bank.
- If sender domain is generic/unknown and body is ambiguous, return { "is_bank": false }.

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
          modelUsed: CONSTANTS.OPENAI_MODEL_CLASSIFY,
        }).catch(() => null);
      }

      const raw = JSON.parse(response.choices[0].message.content || '{}');
      if (!raw.is_bank) return null;
      return { name: raw.bank_name, shortCode: raw.short_code, country: raw.country };
    } catch (error) {
      if (this.isRateLimitError(error)) {
        logger.warn(`Rate-limited while identifying bank for sender ${senderEmail}`);
        return null;
      }
      logger.error(`Error identifying bank from email ${senderEmail} - ${error}`);
      return null;
    }
  }

  async captureBlueprint(
    bankId: number,
    transactionType: 'debit' | 'credit',
    emailSubject: string,
    emailBody: string,
  ): Promise<void> {
    try {
      const sanitizedSubject = this.sanitizeBlueprintText(emailSubject, BLUEPRINT_SUBJECT_MAX_LEN);
      const sanitizedBody = this.sanitizeBlueprintText(emailBody, BLUEPRINT_BODY_MAX_LEN);
      if (!sanitizedBody) return;

      const formatSignature = this.buildFormatSignature(sanitizedSubject, sanitizedBody);
      const existing = await this.repository.findBlueprintByBankAndType(bankId, transactionType);
      if (!existing) {
        await this.repository.createBlueprint({
          bankId,
          transactionType,
          sanitizedSubject,
          sanitizedBody,
          formatSignature,
          sampleCount: 1,
          driftCount: 0,
        });
        return;
      }

      if (existing.formatSignature === formatSignature) {
        await this.repository.updateBlueprint(existing.id, {
          sampleCount: existing.sampleCount + 1,
          driftCount: 0,
        });
        return;
      }

      const nextDriftCount = existing.driftCount + 1;
      if (nextDriftCount >= BLUEPRINT_DRIFT_REPLACE_THRESHOLD) {
        await this.repository.updateBlueprint(existing.id, {
          sanitizedSubject,
          sanitizedBody,
          formatSignature,
          sampleCount: 1,
          driftCount: 0,
        });
        logger.info(
          `[ParserRule] Replaced ${transactionType} blueprint for bank ${bankId} after detecting format drift`,
        );
        return;
      }

      await this.repository.updateBlueprint(existing.id, {
        sampleCount: existing.sampleCount + 1,
        driftCount: nextDriftCount,
      });
    } catch (error) {
      logger.error(
        `[ParserRule] Failed to capture ${transactionType} blueprint for bank ${bankId} - ${error}`,
      );
    }
  }

  private isRateLimitError(error: unknown): boolean {
    const e = error as { status?: number; message?: string };
    return e?.status === 429 || (e?.message || '').includes('429');
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

  private assignParsedField(
    result: ParsedTransaction,
    field: RuleFieldEnum,
    value: string | number,
  ): void {
    if (field === RuleFieldEnum.TRANSACTION_TYPE) {
      result.transactionType = String(value);
      return;
    }
    (result as any)[field] = value;
  }

  private async getBlueprintContext(bankId: number): Promise<string> {
    try {
      const blueprints = await this.repository.findBlueprintsByBank(bankId);
      if (blueprints.length === 0) return 'none';

      return blueprints
        .map(
          (bp) =>
            `- ${bp.transactionType.toUpperCase()} subject: ${bp.sanitizedSubject}\n` +
            `  ${bp.transactionType.toUpperCase()} body:\n${bp.sanitizedBody.substring(0, 1200)}`,
        )
        .join('\n\n');
    } catch (error) {
      logger.warn(`[ParserRule] Blueprint context unavailable for bank ${bankId} - ${error}`);
      return 'none';
    }
  }

  private sanitizeBlueprintText(input: string, maxLen: number): string {
    const normalized = (input || '')
      .replace(/\r/g, '')
      .replace(/\t/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    const redacted = normalized
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<EMAIL>')
      .replace(/\b\d{10,}\b/g, '<LONG_NUMBER>')
      .replace(/\b\d{4}[*xX]+\d{2,}\b/g, '<MASKED_ACCOUNT>')
      .replace(/\b(?:acct|account)\s*(?:number|no\.?|num)?\s*[:#-]?\s*\d+[A-Z0-9*X-]*/gi, 'account <ACCOUNT>')
      .replace(/\b(?:ref(?:erence)?|rrn|session\s*id|document\s*number)\s*[:#-]?\s*[A-Z0-9/-]{6,}\b/gi, 'reference <REFERENCE>');

    return redacted.length > maxLen ? redacted.slice(0, maxLen) : redacted;
  }

  private buildFormatSignature(subject: string, body: string): string {
    const labelMatches = Array.from(body.matchAll(/(^|\n)\s*([A-Za-z][A-Za-z\s]{2,40})\s*:/g))
      .map((m) => m[2].toLowerCase().replace(/\s+/g, ' ').trim())
      .slice(0, 40)
      .join('|');
    const normalizedSubject = subject
      .toLowerCase()
      .replace(/\d+/g, '<N>')
      .replace(/\s+/g, ' ')
      .trim();
    const fingerprint = `${normalizedSubject}::${labelMatches}`;
    return createHash('sha256').update(fingerprint).digest('hex');
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
