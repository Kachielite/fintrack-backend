export enum TransactionTypeEnum {
  DEBIT = 'debit',
  CREDIT = 'credit',
}

export enum TransactionStatusEnum {
  VERIFIED = 'verified',
  UNVERIFIED = 'unverified',
  REVIEW = 'review',
  CORRECTED = 'corrected',
}

// Category slugs — these match the `slug` column in the categories table.
// Used as fallback constants; runtime validation is DB-driven (not enum-based).
export enum CategoryEnum {
  PEER_TO_PEER_TRANSFER = 'peer_to_peer_transfer',
  BUSINESS_PAYMENT = 'business_payment',
  SUBSCRIPTIONS = 'subscriptions',
  ENTERTAINMENT_LEISURE = 'entertainment_leisure',
  MOBILE_INTERNET = 'mobile_internet',
  UTILITIES = 'utilities',
  GROCERIES = 'groceries',
  RETAIL_ECOMMERCE = 'retail_ecommerce',
  DINING_FOOD_DELIVERY = 'dining_food_delivery',
  TRANSPORT = 'transport',
  FUEL_AUTO = 'fuel_auto',
  TRAVEL = 'travel',
  BANK_CHARGES = 'bank_charges',
  CURRENCY_CONVERSION = 'currency_conversion',
  INVESTMENT = 'investment',
  SAVINGS = 'savings',
  RENT_HOUSING = 'rent_housing',
  SALARY_WAGES = 'salary_wages',
  REFUNDS_REIMBURSEMENTS = 'refunds_reimbursements',
  HEALTHCARE = 'healthcare',
  EDUCATION = 'education',
  CHARITY_DONATIONS = 'charity_donations',
  CASH_WITHDRAWAL = 'cash_withdrawal',
  FAMILY_SUPPORT = 'family_support',
  BEAUTY_PERSONAL_CARE = 'beauty_personal_care',
  GIFTS_SOCIAL = 'gifts_social',
  UNCATEGORIZED = 'uncategorized',
}
