import { inject, injectable } from 'tsyringe';
import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import { CONSTANTS } from '@/common/configuration/constants';
import { InternalServerException, ResourceNotFoundException } from '@/common/exception';
import logger from '@/common/lib/logger';
import { IParserRuleRepository } from './parser-rule.repository';
import {
  IParserRule,
  IParserTemplate,
  IParserTemplateWithRules,
  ParsedTransaction,
  TemplateParseResult,
  AuditResult,
  RateLimitedExtractionError,
} from './parser-rule.interface';
import { ParserTemplateResponseDTO } from './parser-rule.dto';
import { RuleStatusEnum, RuleFieldEnum, RuleCreatorEnum } from './parser-rule.enum';
import { IAiUsageRepository } from '@/modules/admin/admin.repository';
import { BankIdentificationSource } from '@/modules/bank/bank-matching';
import { execRuleBatchWithTimeout, RegexBatchRule } from './regex-sandbox';

const DEFAULT_CATEGORIES = [
  { slug: 'peer_to_peer_transfer', name: 'Peer-to-Peer Transfer', regex: null },
  { slug: 'business_payment', name: 'Business Payment', regex: null },
  { slug: 'subscriptions', name: 'Subscriptions', regex: null },
  { slug: 'entertainment_leisure', name: 'Entertainment & Leisure', regex: null },
  { slug: 'mobile_internet', name: 'Mobile & Internet', regex: null },
  { slug: 'utilities', name: 'Utilities', regex: null },
  { slug: 'groceries', name: 'Groceries', regex: null },
  { slug: 'retail_ecommerce', name: 'Retail & E-Commerce', regex: null },
  { slug: 'dining_food_delivery', name: 'Dining & Food Delivery', regex: null },
  { slug: 'transport', name: 'Transport', regex: null },
  { slug: 'fuel_auto', name: 'Fuel & Auto', regex: null },
  { slug: 'travel', name: 'Travel', regex: null },
  { slug: 'bank_charges', name: 'Bank Charges', regex: null },
  { slug: 'currency_conversion', name: 'Currency Conversion', regex: null },
  { slug: 'self_transfer', name: 'Self-Transfer', regex: null },
  { slug: 'salary_wages', name: 'Salary & Wages', regex: null },
  { slug: 'refunds_reimbursements', name: 'Refunds & Reimbursements', regex: null },
  { slug: 'healthcare', name: 'Healthcare', regex: null },
  { slug: 'education', name: 'Education', regex: null },
  { slug: 'charity_donations', name: 'Charity & Donations', regex: null },
  { slug: 'cash_withdrawal', name: 'Cash Withdrawal', regex: null },
  { slug: 'uncategorized', name: 'Uncategorized', regex: null },
];

export interface IdentifiedBank {
  name: string;
  shortCode: string;
  country: string;
}

export interface CsvColumnMapping {
  dateColumn: string;
  dateFormat: string | null;
  merchantColumn: string;
  amountMode: 'single_signed' | 'single_unsigned_with_type' | 'debit_credit_split';
  amountColumn: string | null;
  typeColumn: string | null;
  debitColumn: string | null;
  creditColumn: string | null;
  currencyColumn: string | null;
  defaultCurrency: string | null;
  referenceColumn: string | null;
  balanceColumn: string | null;
}

export interface BulkReauditResult {
  total: number;
  promoted: number;
  stillFailed: number;
  errors: number;
}

export interface ExtractedStatementTransaction {
  date: string;
  merchant: string;
  amount: number;
  transactionType: 'debit' | 'credit';
  currency: string | null;
  reference: string | null;
  balance: number | null;
}

export interface IParserRuleService {
  listProductionTemplates(): Promise<ParserTemplateResponseDTO[]>;
  getTemplate(id: number): Promise<IParserTemplateWithRules>;
  auditTemplate(templateId: number, senderConfidence?: BankIdentificationSource): Promise<AuditResult>;
  bulkReauditFailed(): Promise<BulkReauditResult>;
  promoteTemplate(id: number): Promise<ParserTemplateResponseDTO>;
  applyTemplate(
    bankId: number,
    emailBody: string,
    emailSubject: string,
  ): Promise<TemplateParseResult | null>;
  /**
   * Returns null when the AI genuinely judged the email not to be a
   * transaction. Throws RateLimitedExtractionError when the OpenAI call
   * itself was rate-limited — callers must not collapse the two cases.
   */
  extractTransaction(
    bankName: string,
    emailBody: string,
    emailSubject: string,
    categories?: { slug: string; name: string; regex: string | null }[],
  ): Promise<ParsedTransaction | null>;
  generateTemplate(
    bankId: number,
    emailBody: string,
    emailSubject: string,
  ): Promise<IParserTemplate>;
  /**
   * Any template row for this bank and this email's format, regardless of
   * status (fintrack-backend#140). Scoped per-format, not just per-bank, so a
   * bank's other email shapes each still get their own generation attempt
   * (fintrack-backend#160).
   */
  hasExistingTemplate(bankId: number, emailSubject: string, emailBody: string): Promise<boolean>;
  /**
   * Public wrapper around the same fingerprint hasExistingTemplate/generateTemplate
   * use internally, so callers (ingestion.service.ts's in-flight/cooldown guards)
   * can key per-format state with the exact same identity the DB check uses,
   * rather than approximating it separately.
   */
  computeFormatSignature(emailSubject: string, emailBody: string): string;
  identifyBank(
    senderEmail: string,
    emailSubject: string,
    emailBody: string,
  ): Promise<IdentifiedBank | null>;
  inferCategoryFromText(
    merchant: string,
    description: string,
    allowedCategories: string[],
  ): Promise<string | null>;
  detectCsvMapping(
    headers: string[],
    sampleRows: Record<string, string>[],
  ): Promise<CsvColumnMapping | null>;
  extractTransactionsFromDocument(
    text: string,
    defaultCurrency: string,
  ): Promise<ExtractedStatementTransaction[] | null>;
  captureBlueprint(
    bankId: number,
    transactionType: 'debit' | 'credit' | 'unknown',
    emailSubject: string,
    emailBody: string,
    failed?: boolean,
  ): Promise<void>;
  recordMatch(templateId: number): Promise<void>;
  recordFailure(templateId: number): Promise<void>;
}

const BLUEPRINT_BODY_MAX_LEN = 3000;
const BLUEPRINT_SUBJECT_MAX_LEN = 240;
// Each distinct email shape within a (bank, transactionType) bucket gets its
// own blueprint row (see fintrack-backend#184) instead of the old single-row-
// per-bucket model, so nothing bounds bucket growth anymore except this cap.
// Wide enough that a bank's real concurrently-active formats (plain debit, FX
// debit, ...) all fit comfortably; a bucket hitting this is far more likely
// noise (misclassified sender, near-random AI output) than genuine format
// diversity. Evicting the least-recently-updated slot when it's exceeded
// keeps the table bounded without needing a separate cleanup job.
const BLUEPRINT_MAX_SLOTS_PER_BUCKET = 8;
// Don't demote a template back to candidate off early noise — one failure right
// after one success computes to a score of 1/3, well under REGEX_REAUDIT_THRESHOLD.
// Require a minimum number of real applications before the score is trusted enough
// to act on. See fintrack-backend#154.
const REGEX_DEMOTION_MIN_SAMPLES = 5;
// matchCount/failCount are lifetime cumulative, so a template with a long
// healthy history barely moves the score on a handful of new failures - a
// bank redesigning its email format (every subsequent match now fails) could
// mismatch forever under the lifetime-average check alone. This tracks
// consecutive failures since the last match instead, independent of history
// length, and demotes as soon as the streak looks like a real format change
// rather than noise. See fintrack-backend#165.
const REGEX_ROLLING_DEMOTION_FAIL_STREAK = 5;
// A legitimate rule against a bounded-length email body should complete in
// well under 1ms - this is a wide safety margin, not a tight budget, since the
// point is to catch genuinely pathological (catastrophic-backtracking) input,
// not to be a performance tripwire. See fintrack-backend#167.
const REGEX_EXECUTION_TIMEOUT_MS = 200;

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

  async auditTemplate(templateId: number, senderConfidence?: BankIdentificationSource): Promise<AuditResult> {
    try {
      const template = await this.repository.findTemplateById(templateId);
      if (!template) throw new ResourceNotFoundException('Template not found');

      // A template built from a weakly-identified sender needs stronger evidence
      // before it's trusted without an LLM review. Unknown confidence (manual/bulk
      // re-audit, no triggering email) is treated as weak, not as strong.
      const autoPassThreshold =
        senderConfidence === 'exact_sender_email' || senderConfidence === 'trusted_sender_domain'
          ? 2
          : senderConfidence === 'legacy_domain_fallback' || senderConfidence === 'domain_name_hint'
            ? 3
            : Infinity; // 'ai_identified' or unknown — never fast-path, always go through the judge

      // Run each rule against real blueprint text to get actual match evidence
      const blueprints = await this.repository.findBlueprintsByBank(template.bankId);
      const blueprintTexts = blueprints.map((bp) => `${bp.sanitizedSubject} ${bp.sanitizedBody}`);

      let amountActuallyMatched = false;
      let totalActuallyMatched = 0;

      const rulesWithMatches = template.rules.map((r) => {
        let actualMatch: string | null = null;
        let matched = false;
        try {
          const { pattern, flags } = this.sanitizePattern(r.pattern, r.flags);
          const regex = new RegExp(pattern, flags);
          for (const text of blueprintTexts) {
            const m = regex.exec(text);
            if (m && m[r.extractGroup]) {
              actualMatch = m[r.extractGroup].trim();
              matched = true;
              break;
            }
          }
        } catch {
          // invalid regex — leave matched: false
        }
        // Amount/balance captures must actually parse as a sane number before
        // they count toward auto-pass — a matched-but-garbage capture (e.g. "N/A",
        // a stray label) shouldn't be treated as real evidence of a working rule.
        const isNumericField = r.field === RuleFieldEnum.AMOUNT || r.field === RuleFieldEnum.BALANCE;
        const numericallySane = !isNumericField || this.parseNumericSanity(actualMatch) != null;
        if (matched && numericallySane) {
          totalActuallyMatched++;
          if (r.field === RuleFieldEnum.AMOUNT) amountActuallyMatched = true;
        }
        return { id: r.id, field: r.field, pattern: r.pattern, flags: r.flags, matched, actual_match: actualMatch };
      });

      // Auto-promote without AI call if real-world matches confirm quality
      if (amountActuallyMatched && totalActuallyMatched >= autoPassThreshold && blueprints.length > 0) {
        await this.repository.updateTemplateStatus(
          templateId,
          RuleStatusEnum.AUDITED,
          `Auto-passed: ${totalActuallyMatched}/${template.rules.length} fields matched against blueprint`,
        );
        await this.repository.updateTemplateStatus(templateId, RuleStatusEnum.PRODUCTION);
        return {
          passed: true,
          notes: `Auto-passed: ${totalActuallyMatched}/${template.rules.length} fields matched against real blueprint text`,
          fieldResults: rulesWithMatches.map((r) => ({
            field: r.field,
            passed: r.matched,
            concern: r.matched ? `captured: "${r.actual_match}"` : 'no match in blueprint',
          })),
        };
      }

      // A template with no working amount rule can never produce a transaction -
      // ingestion.service.ts hard-gates the regex-success path on parsedAmount
      // != null. No LLM judge opinion can make an amount-less template usable,
      // so fail it here without spending a call: the LLM-judge path below only
      // nudges toward passing when amount *did* match, it never hard-requires
      // amount coverage the way the fast auto-promote path above does. See
      // fintrack-backend#183.
      if (!amountActuallyMatched) {
        const notes =
          'Failed: no amount rule matched real blueprint text - a template cannot be promoted without a working amount extraction';
        await this.repository.updateTemplateStatus(templateId, RuleStatusEnum.FAILED_AUDIT, notes);
        return {
          passed: false,
          notes,
          fieldResults: rulesWithMatches.map((r) => ({
            field: r.field,
            passed: r.matched,
            concern: r.matched ? `captured: "${r.actual_match}"` : 'no match in blueprint',
          })),
        };
      }

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
            content: `Audit the following regex rules for a bank email parser.
Each rule shows what it actually captured from real blueprint text in the "actual_match" field.

${JSON.stringify(rulesWithMatches, null, 2)}

Known bank blueprint samples (sanitized):
${blueprintContext}

For rules with actual_match: verify the captured value is correct for that field.
For rules with matched: false: assess if the field is absent from this email format or if the pattern is wrong.

IMPORTANT: If the "amount" field matched and captured a plausible number, lean toward passed: true even if other fields have concerns or are absent.

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

      // Override AI fail if real-world evidence meets the confidence-scaled bar
      const effectivePassed = result.passed || (amountActuallyMatched && totalActuallyMatched >= autoPassThreshold);

      await this.repository.updateTemplateStatus(
        templateId,
        effectivePassed ? RuleStatusEnum.AUDITED : RuleStatusEnum.FAILED_AUDIT,
        result.notes,
      );

      if (effectivePassed) {
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

  async bulkReauditFailed(): Promise<BulkReauditResult> {
    const failed = await this.repository.findTemplatesByStatus(RuleStatusEnum.FAILED_AUDIT);
    // Templates demoted from production by recordFailure (lifetime score or
    // fintrack-backend#165's rolling fail-streak) sit at CANDIDATE with no
    // automatic path back to re-audit otherwise - swept here alongside
    // failed_audit templates since both need a fresh audit attempt.
    const demoted = await this.repository.findDemotedTemplates();
    const templates = [...failed, ...demoted];
    logger.info(
      `[ParserRule] Bulk re-audit: ${failed.length} failed templates, ${demoted.length} demoted templates`,
    );

    let promoted = 0;
    let stillFailed = 0;
    let errors = 0;

    for (const template of templates) {
      try {
        const result = await this.auditTemplate(template.id);
        if (result.passed) promoted++;
        else stillFailed++;
      } catch (err) {
        errors++;
        logger.warn(`[ParserRule] Bulk re-audit error on template ${template.id}: ${err}`);
      }
      // Small delay to avoid rate-limiting OpenAI back-to-back
      await new Promise((r) => setTimeout(r, 200));
    }

    logger.info(`[ParserRule] Bulk re-audit done: promoted=${promoted}, failed=${stillFailed}, errors=${errors}`);
    return { total: templates.length, promoted, stillFailed, errors };
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

      let bestMatch: {
        templateId: number;
        confidenceScore: number;
        matchCount: number;
        parsed: ParsedTransaction;
        score: number;
        matchedCount: number;
      } | null = null;

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

        const batch: RegexBatchRule[] = [];
        const batchRules: IParserRule[] = [];
        for (const rule of template.rules) {
          try {
            const { pattern, flags } = this.sanitizePattern(rule.pattern, rule.flags);
            batch.push({ pattern, flags, extractGroup: rule.extractGroup });
            batchRules.push(rule);
          } catch (ruleErr) {
            logger.warn(`Skipping bad regex rule ${rule.id} for bank ${bankId}: ${ruleErr}`);
          }
        }

        const batchResult = await execRuleBatchWithTimeout(batch, emailBody, REGEX_EXECUTION_TIMEOUT_MS);
        if (batchResult.timedOut) {
          logger.warn(
            `[ParserRule] Regex batch timed out for template ${template.id} (bank ${bankId}) - skipping this template for this email`,
          );
          setImmediate(() => {
            this.recordFailure(template.id).catch((err) => {
              logger.error(`Failed to record timeout failure for template ${template.id} - ${err}`);
            });
          });
          continue;
        }

        batchRules.forEach((rule, i) => {
          const value = batchResult.results[i];
          const trimmed = value?.trim();
          if (!trimmed) return;
          this.assignParsedField(
            result,
            rule.field as RuleFieldEnum,
            this.parseFieldValue(rule.field as RuleFieldEnum, trimmed),
          );
          matchedCount++;
          if (rule.field === RuleFieldEnum.AMOUNT) requiredMatched = true;
        });

        const minMatched = template.rules.length <= 1 ? 1 : 2;
        if (!requiredMatched || matchedCount < minMatched || Object.keys(result).length === 0) {
          continue;
        }

        const score = matchedCount / Math.max(template.rules.length, 1);
        if (!bestMatch || score > bestMatch.score || (score === bestMatch.score && matchedCount > bestMatch.matchedCount)) {
          bestMatch = {
            templateId: template.id,
            confidenceScore: template.confidenceScore,
            matchCount: template.matchCount,
            parsed: result,
            score,
            matchedCount,
          };
        }
      }

      if (!bestMatch) return null;
      return {
        templateId: bestMatch.templateId,
        confidenceScore: bestMatch.confidenceScore,
        matchCount: bestMatch.matchCount,
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
    categories?: { slug: string; name: string; regex: string | null }[],
  ): Promise<ParsedTransaction | null> {
    try {
      const categoryList = (categories && categories.length > 0 ? categories : DEFAULT_CATEGORIES)
        .map((c) => `- ${c.slug}${c.name !== c.slug ? ` (${c.name})` : ''}${c.regex ? `: matches /${c.regex}/` : ''}`)
        .join('\n');

      const categorySlugs = (categories && categories.length > 0 ? categories : DEFAULT_CATEGORIES)
        .map((c) => `"${c.slug}"`)
        .join(' | ');

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

CATEGORY CLASSIFICATION — choose the slug that best fits. Use the regex hints and known brand names to guide your choice:
${categoryList}

Brand → category hints:
- Spotify, Netflix, Apple Music/TV+, YouTube Premium, JetBrains, GitHub Copilot, AWS, Vercel, Figma, Notion, Slack, 1Password, Anthropic, Claude.ai, OpenAI, ChatGPT, Paddle.NET, Adobe → subscriptions
- X Corp., Twitter → subscriptions
- DSTV, GOtv, Showmax, Silverbird Cinema, Genesis Cinema → entertainment_leisure
- Glovo, Uber Eats, Bolt Food, Jumia Food, DoorDash, Deliveroo, The Place, KFC, McDonald's → dining_food_delivery
- Uber (non-eats), Bolt (non-food), inDrive, Taxify, Lyft → transport
- MTN, Airtel (non-transfer), Glo, 9mobile, Safaricom, Data Purchase → mobile_internet
- Shoprite, Jumia (non-food), Amazon (non-AWS), Konga → retail_ecommerce
- PHCN, EKEDC, IKEDC, AEDC, electricity, water bill → utilities
- ATM withdrawal, cash out → cash_withdrawal
- FCY Conversion, currency conversion → currency_conversion
- SMS charge, card maintenance, account maintenance, stamp duty, interest charge → bank_charges
- Salary, payroll, stipend credit → salary_wages
- Reversal, refund, cashback → refunds_reimbursements
- Transfer to/from a person's name → peer_to_peer_transfer`,
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
  "category": ${categorySlugs},
  "transaction_date": "<transaction datetime in ISO 8601 (YYYY-MM-DDTHH:mm:ss) when available; otherwise YYYY-MM-DD; null if not found>",
  "balance": <account balance number after transaction, or null>,
  "reference": "<transaction reference/ID if present, else null>",
  "account_number": "<masked/partial account number if present, e.g. digits after 'A/C' or 'account ending', else null>"
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
      if (raw.account_number) result.accountNumberMask = raw.account_number;
      return result;
    } catch (error) {
      if (this.isRateLimitError(error)) {
        logger.warn(`Rate-limited while extracting transaction for bank ${bankName}`);
        throw new RateLimitedExtractionError(`Rate-limited while extracting transaction for bank ${bankName}`);
      }
      logger.error(`Error extracting transaction for bank ${bankName} - ${error}`);
      return null;
    }
  }

  async hasExistingTemplate(bankId: number, emailSubject: string, emailBody: string): Promise<boolean> {
    const formatSignature = this.buildFormatSignature(emailSubject, emailBody);
    return this.repository.hasTemplateForBankAndSignature(bankId, formatSignature);
  }

  computeFormatSignature(emailSubject: string, emailBody: string): string {
    return this.buildFormatSignature(emailSubject, emailBody);
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
- Only include fields that are actually present and clearly identifiable in the email text.

Fields to extract:
- amount: the transaction amount as a number string (e.g. "5,000.00")
- currency: the currency code or symbol (e.g. "NGN", "₦")
- merchant: merchant or recipient name
- transaction_type: "debit" or "credit"
- transaction_date: the transaction date/time (e.g. "01 Jan 2025", "2025-01-01", compact forms like "01Sep2025")
- balance: account balance after transaction
- reference: transaction reference number
- account_number: masked/partial account number if present (e.g. digits after "A/C" or "account ending")

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
        formatSignature: this.buildFormatSignature(emailSubject, emailBody),
      });

      // Collect all texts to test against: existing blueprints + current email
      const blueprints = await this.repository.findBlueprintsByBank(bankId);
      const testTexts = [
        `${emailSubject} ${emailBody.substring(0, 3000)}`,
        ...blueprints.map((bp) => `${bp.sanitizedSubject} ${bp.sanitizedBody}`),
      ];

      for (const [field, ruleData] of Object.entries(raw.fields || {})) {
        const rd = ruleData as any;
        const { pattern, flags } = this.sanitizePattern(rd.pattern, rd.flags || 'i');

        // Reject catastrophic-backtracking shapes before this pattern is ever
        // saved — an AI-written regex runs unsupervised against every future
        // email from this bank, so a ReDoS pattern here is a production outage.
        if (this.isUnsafeRegexPattern(pattern)) {
          logger.warn(
            `[ParserRule] Rejecting unsafe regex for field ${field} on bank ${bankId} (potential catastrophic backtracking): ${pattern}`,
          );
          continue;
        }

        // Pre-test: skip rules that are invalid or don't match any available text
        let matched = false;
        try {
          const regex = new RegExp(pattern, flags);
          matched = testTexts.some((text) => regex.test(text));
        } catch (regexErr) {
          logger.warn(`[ParserRule] Skipping invalid regex for field ${field} on bank ${bankId}: ${regexErr}`);
          continue;
        }

        if (!matched) {
          logger.info(`[ParserRule] Skipping field "${field}" — regex did not match any blueprint or current email`);
          continue;
        }

        const rule = await this.repository.createRule({
          bankId,
          field: field as RuleFieldEnum,
          pattern,
          flags,
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

  async inferCategoryFromText(
    merchant: string,
    description: string,
    allowedCategories: string[],
  ): Promise<string | null> {
    try {
      const allowed = Array.from(new Set(allowedCategories.map((s) => s.toLowerCase().trim()).filter(Boolean)));
      if (allowed.length === 0) return null;

      const response = await this.openai.chat.completions.create({
        model: CONSTANTS.OPENAI_MODEL_CLASSIFY,
        messages: [
          {
            role: 'system',
            content:
              'You classify a financial transaction category from merchant/description text. Return JSON only.',
          },
          {
            role: 'user',
            content: `Merchant: ${merchant || 'unknown'}
Description: ${description || 'unknown'}

Allowed category slugs:
${allowed.join(', ')}

Return JSON in this format:
{ "category": "<one allowed slug>" }

If none confidently matches, return:
{ "category": null }`,
          },
        ],
        response_format: { type: 'json_object' },
      });

      if (response.usage) {
        this.aiUsageRepository.log({
          operation: 'infer_category',
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
          modelUsed: CONSTANTS.OPENAI_MODEL_CLASSIFY,
        }).catch(() => null);
      }

      const raw = JSON.parse(response.choices[0].message.content || '{}');
      const category = String(raw.category || '').toLowerCase().trim();
      if (!category) return null;
      return allowed.includes(category) ? category : null;
    } catch (error) {
      if (this.isRateLimitError(error)) {
        logger.warn('Rate-limited while inferring category from merchant/description');
        return null;
      }
      logger.error(`Error inferring category from merchant/description - ${error}`);
      return null;
    }
  }

  async detectCsvMapping(
    headers: string[],
    sampleRows: Record<string, string>[],
  ): Promise<CsvColumnMapping | null> {
    try {
      if (headers.length === 0) return null;
      const sample = sampleRows
        .slice(0, 5)
        .map((row) => JSON.stringify(row))
        .join('\n');

      const response = await this.openai.chat.completions.create({
        model: CONSTANTS.OPENAI_MODEL_TEMPLATE,
        messages: [
          {
            role: 'system',
            content: `You analyze the structure of a CSV export of bank/financial transactions and identify which columns hold which data. Return JSON only.

Bank statement CSVs vary widely:
- Amount may be a single signed column (negative = debit), a single unsigned column paired with a type/direction column (e.g. "Debit"/"Credit" or "DR"/"CR"), or split into two separate columns (one for debits/withdrawals, one for credits/deposits).
- Dates can be in many formats — infer the day/month/year order and separator from the sample values.
- Not every CSV has a currency, reference, or balance column — these are optional. When there's no per-row currency column, look for a currency hint elsewhere — a symbol or code embedded in a column header (e.g. "Amt (NGN)", "Amount ($)") or in the sample values themselves — and report it as a single default currency for the whole file.
- If the file clearly isn't transaction data (e.g. it's something else entirely), set confident to false.`,
          },
          {
            role: 'user',
            content: `Column headers: ${JSON.stringify(headers)}

Sample rows (JSON, one per line):
${sample}

Return JSON in this exact format:
{
  "date_column": "<exact header name for the transaction date>",
  "date_format": "<a pattern like DD/MM/YYYY, MM/DD/YYYY, or YYYY-MM-DD describing the sample values, or null if unclear>",
  "merchant_column": "<exact header name for description/merchant/narration>",
  "amount_mode": "single_signed" | "single_unsigned_with_type" | "debit_credit_split",
  "amount_column": "<exact header name, or null>",
  "type_column": "<exact header name for a debit/credit indicator, or null>",
  "debit_column": "<exact header name for the debit/withdrawal amount column, or null>",
  "credit_column": "<exact header name for the credit/deposit amount column, or null>",
  "currency_column": "<exact header name, or null if not present>",
  "default_currency": "<ISO 4217 code guessed from header names/symbols/sample values when there's no currency_column, or null if you can't tell>",
  "reference_column": "<exact header name, or null>",
  "balance_column": "<exact header name, or null>",
  "confident": <true if this mapping is correct, false if the file doesn't look like transaction data>
}

Every column name in your response must exactly match one of the given headers, or be null.`,
          },
        ],
        response_format: { type: 'json_object' },
      });

      if (response.usage) {
        this.aiUsageRepository.log({
          operation: 'detect_csv_mapping',
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
          modelUsed: CONSTANTS.OPENAI_MODEL_TEMPLATE,
        }).catch(() => null);
      }

      const raw = JSON.parse(response.choices[0].message.content || '{}');
      if (!raw.confident) return null;

      const headerSet = new Set(headers);
      const resolveColumn = (value: unknown): string | null =>
        typeof value === 'string' && headerSet.has(value) ? value : null;

      const dateColumn = resolveColumn(raw.date_column);
      const merchantColumn = resolveColumn(raw.merchant_column);
      const amountColumn = resolveColumn(raw.amount_column);
      const debitColumn = resolveColumn(raw.debit_column);
      const creditColumn = resolveColumn(raw.credit_column);
      const amountMode: CsvColumnMapping['amountMode'] =
        raw.amount_mode === 'debit_credit_split' || raw.amount_mode === 'single_unsigned_with_type'
          ? raw.amount_mode
          : 'single_signed';

      if (!dateColumn || !merchantColumn) return null;
      if (amountMode === 'debit_credit_split' && !debitColumn && !creditColumn) return null;
      if (amountMode !== 'debit_credit_split' && !amountColumn) return null;

      return {
        dateColumn,
        dateFormat: typeof raw.date_format === 'string' ? raw.date_format : null,
        merchantColumn,
        amountMode,
        amountColumn,
        typeColumn: resolveColumn(raw.type_column),
        debitColumn,
        creditColumn,
        currencyColumn: resolveColumn(raw.currency_column),
        defaultCurrency:
          typeof raw.default_currency === 'string' && /^[A-Za-z]{3}$/.test(raw.default_currency)
            ? raw.default_currency.toUpperCase()
            : null,
        referenceColumn: resolveColumn(raw.reference_column),
        balanceColumn: resolveColumn(raw.balance_column),
      };
    } catch (error) {
      if (this.isRateLimitError(error)) {
        logger.warn('Rate-limited while detecting CSV column mapping');
        throw new InternalServerException('OpenAI rate limit reached while analyzing CSV');
      }
      logger.error(`Error detecting CSV column mapping - ${error}`);
      return null;
    }
  }

  /**
   * Bank statement PDFs/Word docs rarely extract as clean tabular text, so
   * unlike CSV/Excel (deterministic column-index parsing after one mapping
   * call) this reads every transaction line directly out of the raw text in
   * a single AI call. Returns null only on a hard failure (API/parse error);
   * a document with no recognizable transactions returns an empty array.
   */
  async extractTransactionsFromDocument(
    text: string,
    defaultCurrency: string,
  ): Promise<ExtractedStatementTransaction[] | null> {
    try {
      const trimmed = text.trim();
      if (!trimmed) return [];

      const response = await this.openai.chat.completions.create({
        model: CONSTANTS.OPENAI_MODEL_EXTRACTION,
        messages: [
          {
            role: 'system',
            content: `You extract every individual transaction line from bank statement text that was already extracted from a PDF or Word document, so spacing/line breaks may be irregular or tables may have collapsed into run-on lines. Return JSON only.

Rules:
- Extract EVERY transaction line visible in the text — do not summarize, deduplicate, or skip any.
- Never invent a transaction that isn't clearly present in the text.
- If you can't confidently read a line's date or amount, omit that line rather than guessing.
- Amounts are always positive numbers; sign is expressed separately via transaction_type.
- Ignore statement headers/footers, running totals, page numbers, and marketing text — only real transaction lines.`,
          },
          {
            role: 'user',
            content: `Default currency (use only when a line doesn't show its own currency): ${defaultCurrency}

Statement text:
${trimmed.substring(0, 20000)}

Return JSON in this exact format:
{
  "transactions": [
    {
      "date": "<ISO 8601 date or datetime, e.g. 2024-01-15>",
      "merchant": "<description/narration/counterparty, cleaned up>",
      "amount": <positive number, no currency symbols or commas>,
      "transaction_type": "debit" | "credit",
      "currency": "<ISO 4217 code if shown for this line, else null>",
      "reference": "<transaction reference/ID if present, else null>",
      "balance": <running balance after this line if shown, else null>
    }
  ]
}

If the text has no recognizable transactions, return { "transactions": [] }.`,
          },
        ],
        response_format: { type: 'json_object' },
      });

      if (response.usage) {
        this.aiUsageRepository.log({
          operation: 'extract_statement_document',
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
          modelUsed: CONSTANTS.OPENAI_MODEL_EXTRACTION,
        }).catch(() => null);
      }

      const raw = JSON.parse(response.choices[0].message.content || '{}');
      if (!Array.isArray(raw.transactions)) return [];

      const results: ExtractedStatementTransaction[] = [];
      for (const item of raw.transactions) {
        const amount = Number(item?.amount);
        const date = typeof item?.date === 'string' ? item.date : '';
        const merchant = typeof item?.merchant === 'string' ? item.merchant.trim() : '';
        const transactionType = item?.transaction_type === 'credit' ? 'credit' : 'debit';
        if (!date || !merchant || !isFinite(amount) || amount <= 0) continue;

        results.push({
          date,
          merchant,
          amount,
          transactionType,
          currency: typeof item?.currency === 'string' && item.currency.trim() ? item.currency.trim() : null,
          reference: typeof item?.reference === 'string' && item.reference.trim() ? item.reference.trim() : null,
          balance: item?.balance != null && isFinite(Number(item.balance)) ? Number(item.balance) : null,
        });
      }
      return results;
    } catch (error) {
      if (this.isRateLimitError(error)) {
        logger.warn('Rate-limited while extracting transactions from document text');
        throw new InternalServerException('OpenAI rate limit reached while analyzing this document');
      }
      logger.error(`Error extracting transactions from document text - ${error}`);
      return null;
    }
  }

  async captureBlueprint(
    bankId: number,
    transactionType: 'debit' | 'credit' | 'unknown',
    emailSubject: string,
    emailBody: string,
    failed = false,
  ): Promise<void> {
    try {
      const sanitizedSubject = this.sanitizeBlueprintText(emailSubject, BLUEPRINT_SUBJECT_MAX_LEN);
      const sanitizedBody = this.sanitizeBlueprintText(emailBody, BLUEPRINT_BODY_MAX_LEN);
      if (!sanitizedBody) return;

      const formatSignature = this.buildFormatSignature(sanitizedSubject, sanitizedBody);
      const existing = await this.repository.findBlueprintByBankTypeAndSignature(
        bankId,
        transactionType,
        formatSignature,
      );
      if (existing) {
        await this.repository.updateBlueprint(existing.id, {
          sampleCount: existing.sampleCount + 1,
          failed,
        });
        return;
      }

      // A genuinely new shape for this bucket - give it its own slot rather
      // than overwriting whatever's already there, so a bank's other active
      // formats keep accumulating evidence independently. See
      // fintrack-backend#184.
      const bucketSlots = await this.repository.findBlueprintsByBankAndType(bankId, transactionType);
      if (bucketSlots.length >= BLUEPRINT_MAX_SLOTS_PER_BUCKET) {
        // <= (not <) so that on an exact timestamp tie - plausible at
        // millisecond resolution when several slots are created in quick
        // succession - the earlier element in iteration order (the one
        // actually inserted first) wins, instead of the reduce drifting
        // forward to the last-seen element on every tied comparison.
        const oldest = bucketSlots.reduce((a, b) => (a.updatedAt <= b.updatedAt ? a : b));
        await this.repository.deleteBlueprint(oldest.id);
        logger.info(
          `[ParserRule] Evicted stale ${transactionType} blueprint slot for bank ${bankId} (least-recently-updated) - bucket was at its ${BLUEPRINT_MAX_SLOTS_PER_BUCKET}-slot cap`,
        );
      }

      await this.repository.createBlueprint({
        bankId,
        transactionType,
        sanitizedSubject,
        sanitizedBody,
        formatSignature,
        sampleCount: 1,
        failed,
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
      if (template.recentFailStreak !== 0) {
        await this.repository.updateRecentFailStreak(templateId, 0);
      }
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

      const newStreak = template.recentFailStreak + 1;
      await this.repository.updateRecentFailStreak(templateId, newStreak);

      const totalSamples = template.matchCount + newFailCount;
      const newScore = template.matchCount / (template.matchCount + newFailCount * 2) || 0;
      const lifetimeScoreDegraded =
        totalSamples >= REGEX_DEMOTION_MIN_SAMPLES && newScore < CONSTANTS.REGEX_REAUDIT_THRESHOLD;
      // Independent of the lifetime-average check above: a template that was
      // fine for months but has failed every attempt since its last match
      // shouldn't have to wait for enough failures to drag its lifetime score
      // down. See fintrack-backend#165.
      const recentStreakDegraded = newStreak >= REGEX_ROLLING_DEMOTION_FAIL_STREAK;

      if (lifetimeScoreDegraded || recentStreakDegraded) {
        const reason = recentStreakDegraded
          ? `${newStreak} consecutive failures - email format may have changed`
          : 'Score fell below reaudit threshold';
        await this.repository.updateTemplateStatus(templateId, RuleStatusEnum.CANDIDATE, reason);
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

  /** Static catastrophic-backtracking check — not a full ReDoS analyzer, just
   * the well-known dangerous shapes (nested/quantified groups, overlapping
   * alternation followed by a quantifier) that account for most real ReDoS bugs. */
  private isUnsafeRegexPattern(pattern: string): boolean {
    // A group containing its own quantifier, itself quantified — e.g. (a+)+,
    // (\d*)+, (x{2,5})*, (a+)? — the classic exponential-backtracking shape.
    const nestedQuantifier = /\([^()]*[+*][^()]*\)[+*?]|\([^()]*\{\d*,?\d*\}[^()]*\)[+*?]/;
    if (nestedQuantifier.test(pattern)) return true;

    // Alternation inside a quantified group — e.g. (a|ab)+ — can blow up when
    // branches share a prefix; flagged conservatively (false positives over
    // silently shipping a ReDoS-capable pattern).
    const alternationThenQuantifier = /\([^()]*\|[^()]*\)[+*]/;
    if (alternationThenQuantifier.test(pattern)) return true;

    return false;
  }

  /** Mirrors ingestion.service.ts's parsePositiveAmount — a captured amount/balance
   * value only counts as real evidence if it actually parses as a positive number. */
  private parseNumericSanity(value: string | null): number | null {
    if (!value) return null;
    const cleaned = value
      .replace(/,/g, '')
      .replace(/[^0-9.\-]/g, '')
      .trim();
    if (!cleaned) return null;
    const parsed = Number(cleaned);
    if (!isFinite(parsed)) return null;
    const abs = Math.abs(parsed);
    return abs > 0 ? abs : null;
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
    if (field === RuleFieldEnum.ACCOUNT_NUMBER) {
      result.accountNumberMask = String(value);
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
