CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  icon TEXT,
  type TEXT NOT NULL DEFAULT 'expense',
  regex TEXT,
  is_system BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO categories (name, slug, description, icon, type, regex) VALUES
-- Transfers
('Peer-to-Peer Transfer', 'peer_to_peer_transfer', 'Money sent directly to individuals, friends, or family through bank transfer, P2P apps, or remittance services.', '👤', 'expense', '(IFO|TRANSFER|P2P|SEND|TO|TRF//FRM|BENEFICIARY|MOBILE\s?MONEY|PERSONAL\s?TRANSFER|PAYMENT\s?TO|[A-Z]{2,}\s+[A-Z]{2,}(\s+[A-Z]{2,})?)'),

-- Business & Subscriptions
('Business Payment', 'business_payment', 'Payments made to businesses or merchants for goods and services, excluding subscriptions and utilities.', '🏢', 'expense', '(POS|WEB|PAYMENT|STORE|MERCHANT|SHOP|ONLINE)\s+[@A-Z0-9_-]+'),
('Subscriptions', 'subscriptions', 'Recurring payments to digital services like music, video streaming, SaaS tools, or online memberships.', '📺', 'expense', '(SPOTIFY|NETFLIX|APPLE|MICROSOFT|GOOGLE|YOUTUBE|DISNEY|SUBSCRIPTION|PLAN|PREMIUM|JETBRAINS|GITHUB)'),

-- Lifestyle & Essentials
('Entertainment & Leisure', 'entertainment_leisure', 'Expenses for movies, games, events, nightlife, or recreational activities.', '🎮', 'expense', '(MOVIE|CINEMA|CLUB|TICKET|EVENT|GAME|PLAYSTATION|STEAM)'),
('Mobile & Internet', 'mobile_internet', 'Payments for mobile top-ups, internet data, broadband, or telecom services.', '📱', 'expense', '(MTN|AIRTEL|GLO|9MOBILE|VODAFONE|SAFARICOM|TELKOM|RECHARGE|DATA|TOP\s?UP|BUNDLE)'),
('Utilities', 'utilities', 'Payments for electricity, water, gas, or similar household services.', '💡', 'expense', '(ELECTRIC|POWER|UTILITY|WATER|GAS|BILL|NEPA|KES|KPLC)'),
('Groceries', 'groceries', 'Purchases from supermarkets, convenience stores, or grocery delivery apps.', '🛒', 'expense', '(SUPERMARKET|GROCERY|SHOPRITE|MARKET|DELIVERY|FOODCO|SUPERMART|GLOVO)'),
('Retail & E-commerce', 'retail_ecommerce', 'Purchases from physical or online retail stores (clothing, electronics, general shopping).', '🛍️', 'expense', '(JUMIA|AMAZON|ALIEXPRESS|SHEIN|EBAY|SHOP|STORE|BOUTIQUE|FASHION)'),
('Dining & Food Delivery', 'dining_food_delivery', 'Restaurant payments, cafés, takeaways, or online food delivery services.', '🍔', 'expense', '(EAT|CAFE|FOOD|RESTAURANT|DELIVERY|UBER\s?EATS|JUMIA\s?FOOD|DOORDASH|GLOVO)'),

-- Transport & Travel
('Transport', 'transport', 'Expenses on taxis, ride-hailing apps, buses, trains, or other local commuting.', '🚕', 'expense', '(UBER|BOLT|TAXI|BUS|TRAIN|FARE|RIDE)'),
('Fuel & Auto', 'fuel_auto', 'Spending on fuel, car maintenance, parking, or tolls.', '⛽', 'expense', '(FILLING\s?STATION|FUEL|PETROL|OIL|AUTO|CAR|SERVICE|LUBRICANT|MECHANIC)'),
('Travel', 'travel', 'Flights, hotels, travel agencies, or vacation-related expenses.', '✈️', 'expense', '(FLIGHT|AIRWAYS|HOTEL|BOOKING|AGENCY|TRIP|VACATION|TRAVEL)'),

-- Financial
('Bank Charges', 'bank_charges', 'Service fees, maintenance charges, card maintenance, ATM fees, or other bank-related deductions.', '🏦', 'expense', '(CHARGE|FEE|MAINTENANCE|ATM\s?FEE|VAT|BANK\s?FEE)'),
('Currency Conversion', 'currency_conversion', 'Debits from converting funds between currencies (FX transactions).', '💱', 'expense', '(FX|FOREX|CONVERSION|USD|GBP|EUR|EXCHANGE)'),
('Investment', 'investment', 'Deposits into investment platforms, stock purchases, mutual funds, or savings-linked investment products.', '📈', 'expense', '(INVESTMENT|STOCKS|SHARES|DIVIDENDS|STASH|COWRYWISE|PIGGYVEST|RISE|BAMBOO|TROVE|MUTUAL\s?FUND|WEALTH)'),
('Savings', 'savings', 'Transfers to dedicated savings accounts, locked funds, or target savings.', '🏦', 'expense', '(SAVINGS|SAVE|PIGGYBANK|STASH|TARGET\s?SAVINGS|LOCK\s?FUNDS|FIXED\s?DEPOSIT)'),
('Rent & Housing', 'rent_housing', 'Rent payments, housing fees, landlord transfers, or property-related expenses.', '🏠', 'expense', '(RENT|HOUSING|LANDLORD|PROPERTY|LEASE|ACCOMMODATION|APARTMENT|AGENT\s?FEE)'),

-- Income
('Salary & Wages', 'salary_wages', 'Credits from salary, wages, or contract payments.', '💼', 'income', '(SALARY|PAYROLL|WAGES|HRPAY|INCOME|PAYMENT\s?FROM|COMPENSATION|TAPPI)'),
('Refunds & Reimbursements', 'refunds_reimbursements', 'Credits from refunds, cashback, or business reimbursements.', '↩️', 'income', '(REFUND|REVERSAL|CASHBACK|REV|REIMBURSE)'),

-- Other Expenses
('Healthcare', 'healthcare', 'Payments for hospitals, pharmacies, medical bills, or insurance.', '🏥', 'expense', '(HOSPITAL|PHARMACY|MEDICAL|CLINIC|HEALTH|INSURANCE|NHIS)'),
('Education', 'education', 'Tuition fees, online courses, learning materials, or academic services.', '🎓', 'expense', '(SCHOOL|TUITION|COURSE|EDU|ACADEMY|E-LEARNING|TRAINING|BOOK)'),
('Charity & Donations', 'charity_donations', 'Payments to charities, NGOs, religious contributions, or crowdfunding.', '🙏', 'expense', '(CHURCH|MOSQUE|CHARITY|DONATION|TITHE|FOUNDATION|NGO)'),
('Cash Withdrawal', 'cash_withdrawal', 'ATM withdrawals or cash taken directly from bank branches.', '💵', 'expense', '(ATM|CASH\s?WITHDRAWAL|BRANCH)'),
('Family Support', 'family_support', 'Regular or one-time financial support sent to family members or dependents.', '👨‍👩‍👧', 'expense', '(FAMILY|SUPPORT|ALLOWANCE|UPKEEP|DEPENDENTS|PARENTS|SIBLINGS|RELATIVE)'),
('Beauty & Personal Care', 'beauty_personal_care', 'Payments for salons, barbers, spas, cosmetics, or personal grooming.', '💅', 'expense', '(SALON|BARBER|BEAUTY|COSMETICS|HAIR|MAKEUP|SKINCARE|SPA|GROOMING|NAIL)'),
('Gifts & Social', 'gifts_social', 'Spending on gifts, celebrations, parties, or social events.', '🎁', 'expense', '(GIFT|PRESENT|CELEBRATION|PARTY|WEDDING|BIRTHDAY|SOCIAL|ANNIVERSARY)'),

-- Fallback
('Uncategorized', 'uncategorized', 'Transactions that do not fit into any predefined category or require manual review.', '❓', 'expense', NULL)
ON CONFLICT (slug) DO NOTHING;
