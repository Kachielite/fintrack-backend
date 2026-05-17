import { RuleStatusEnum, RuleFieldEnum, RuleCreatorEnum } from './parser-rule.enum';

export interface IParserRule {
  id: number;
  bankId: number;
  version: number;
  field: RuleFieldEnum;
  pattern: string;
  flags: string;
  extractGroup: number;
  status: RuleStatusEnum;
  confidenceScore: number;
  matchCount: number;
  failCount: number;
  createdBy: RuleCreatorEnum;
  auditNotes: string | null;
  auditPassedAt: Date | null;
  promotedAt: Date | null;
  deprecatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IParserTemplate {
  id: number;
  bankId: number;
  version: number;
  description: string | null;
  emailSubjectPattern: string | null;
  status: RuleStatusEnum;
  confidenceScore: number;
  matchCount: number;
  failCount: number;
  lastFailedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IParserTemplateWithRules extends IParserTemplate {
  rules: IParserRule[];
}

export interface IBankEmailBlueprint {
  id: number;
  bankId: number;
  transactionType: string;
  sanitizedSubject: string;
  sanitizedBody: string;
  formatSignature: string;
  sampleCount: number;
  driftCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ParsedTransaction {
  amount?: number;
  currency?: string;
  merchant?: string;
  transactionType?: string;
  category?: string;
  date?: string;
  balance?: number;
  reference?: string;
}

export interface TemplateParseResult {
  templateId: number;
  confidenceScore: number;
  matchCount: number;
  parsed: ParsedTransaction;
}

export interface AuditResult {
  passed: boolean;
  notes: string;
  fieldResults: { field: string; passed: boolean; concern?: string }[];
}
