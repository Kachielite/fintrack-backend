export enum RuleStatusEnum {
  CANDIDATE = 'candidate',
  AUDITED = 'audited',
  PRODUCTION = 'production',
  DEPRECATED = 'deprecated',
  FAILED_AUDIT = 'failed_audit',
}

export enum RuleFieldEnum {
  AMOUNT = 'amount',
  CURRENCY = 'currency',
  MERCHANT = 'merchant',
  TRANSACTION_TYPE = 'transaction_type',
  DATE = 'date',
  BALANCE = 'balance',
  REFERENCE = 'reference',
  ACCOUNT_NUMBER = 'account_number',
}

export enum RuleCreatorEnum {
  AI = 'ai',
  MANUAL = 'manual',
}
