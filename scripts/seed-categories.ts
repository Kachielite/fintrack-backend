import 'reflect-metadata';
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { CategorySchema } from '../src/modules/category/category.schema';

const CATEGORIES = [
  { slug: 'peer_to_peer_transfer', name: 'Peer-to-Peer Transfer', icon: '👤', type: 'expense', description: 'Money sent directly to individuals, friends, or family through bank transfer, P2P apps, or remittance services.', regex: '(IFO|TRANSFER|P2P|SEND|TO|TRF//FRM|BENEFICIARY|MOBILE\\s?MONEY|PERSONAL\\s?TRANSFER|PAYMENT\\s?TO|[A-Z]{2,}\\s+[A-Z]{2,}(\\s+[A-Z]{2,})?)' },
  { slug: 'business_payment', name: 'Business Payment', icon: '🏢', type: 'expense', description: 'Payments made to businesses or merchants for goods and services, excluding subscriptions and utilities.', regex: '(POS|WEB|PAYMENT|STORE|MERCHANT|SHOP|ONLINE)\\s+[@A-Z0-9_-]+' },
  { slug: 'subscriptions', name: 'Subscriptions', icon: '📺', type: 'expense', description: 'Recurring payments to digital services like music, video streaming, SaaS tools, or online memberships.', regex: '(SPOTIFY|NETFLIX|APPLE|MICROSOFT|GOOGLE|YOUTUBE|DISNEY|SUBSCRIPTION|PLAN|PREMIUM|JETBRAINS|GITHUB)' },
  { slug: 'entertainment_leisure', name: 'Entertainment & Leisure', icon: '🎮', type: 'expense', description: 'Expenses for movies, games, events, nightlife, or recreational activities.', regex: '(MOVIE|CINEMA|CLUB|TICKET|EVENT|GAME|PLAYSTATION|STEAM)' },
  { slug: 'mobile_internet', name: 'Mobile & Internet', icon: '📱', type: 'expense', description: 'Payments for mobile top-ups, internet data, broadband, or telecom services.', regex: '(MTN|AIRTEL|GLO|9MOBILE|VODAFONE|SAFARICOM|TELKOM|RECHARGE|DATA|TOP\\s?UP|BUNDLE)' },
  { slug: 'utilities', name: 'Utilities', icon: '💡', type: 'expense', description: 'Payments for electricity, water, gas, or similar household services.', regex: '(ELECTRIC|POWER|UTILITY|WATER|GAS|BILL|NEPA|KES|KPLC)' },
  { slug: 'groceries', name: 'Groceries', icon: '🛒', type: 'expense', description: 'Purchases from supermarkets, convenience stores, or grocery delivery apps.', regex: '(SUPERMARKET|GROCERY|SHOPRITE|MARKET|DELIVERY|FOODCO|SUPERMART|GLOVO)' },
  { slug: 'retail_ecommerce', name: 'Retail & E-commerce', icon: '🛍️', type: 'expense', description: 'Purchases from physical or online retail stores (clothing, electronics, general shopping).', regex: '(JUMIA|AMAZON|ALIEXPRESS|SHEIN|EBAY|SHOP|STORE|BOUTIQUE|FASHION)' },
  { slug: 'dining_food_delivery', name: 'Dining & Food Delivery', icon: '🍔', type: 'expense', description: 'Restaurant payments, cafés, takeaways, or online food delivery services.', regex: '(EAT|CAFE|FOOD|RESTAURANT|DELIVERY|UBER\\s?EATS|JUMIA\\s?FOOD|DOORDASH|GLOVO)' },
  { slug: 'transport', name: 'Transport', icon: '🚕', type: 'expense', description: 'Expenses on taxis, ride-hailing apps, buses, trains, or other local commuting.', regex: '(UBER|BOLT|TAXI|BUS|TRAIN|FARE|RIDE)' },
  { slug: 'fuel_auto', name: 'Fuel & Auto', icon: '⛽', type: 'expense', description: 'Spending on fuel, car maintenance, parking, or tolls.', regex: '(FILLING\\s?STATION|FUEL|PETROL|OIL|AUTO|CAR|SERVICE|LUBRICANT|MECHANIC)' },
  { slug: 'travel', name: 'Travel', icon: '✈️', type: 'expense', description: 'Flights, hotels, travel agencies, or vacation-related expenses.', regex: '(FLIGHT|AIRWAYS|HOTEL|BOOKING|AGENCY|TRIP|VACATION|TRAVEL)' },
  { slug: 'bank_charges', name: 'Bank Charges', icon: '🏦', type: 'expense', description: 'Service fees, maintenance charges, card maintenance, ATM fees, or other bank-related deductions.', regex: '(CHARGE|FEE|MAINTENANCE|ATM\\s?FEE|VAT|BANK\\s?FEE)' },
  { slug: 'currency_conversion', name: 'Currency Conversion', icon: '💱', type: 'expense', description: 'Debits from converting funds between currencies (FX transactions).', regex: '(FX|FOREX|CONVERSION|USD|GBP|EUR|EXCHANGE)' },
  { slug: 'investment', name: 'Investment', icon: '📈', type: 'expense', description: 'Deposits into investment platforms, stock purchases, mutual funds, or savings-linked investment products.', regex: '(INVESTMENT|STOCKS|SHARES|DIVIDENDS|STASH|COWRYWISE|PIGGYVEST|RISE|BAMBOO|TROVE|MUTUAL\\s?FUND|WEALTH)' },
  { slug: 'savings', name: 'Savings', icon: '💰', type: 'expense', description: 'Transfers to dedicated savings accounts, locked funds, or target savings.', regex: '(SAVINGS|SAVE|PIGGYBANK|STASH|TARGET\\s?SAVINGS|LOCK\\s?FUNDS|FIXED\\s?DEPOSIT)' },
  { slug: 'rent_housing', name: 'Rent & Housing', icon: '🏠', type: 'expense', description: 'Rent payments, housing fees, landlord transfers, or property-related expenses.', regex: '(RENT|HOUSING|LANDLORD|PROPERTY|LEASE|ACCOMMODATION|APARTMENT|AGENT\\s?FEE)' },
  { slug: 'salary_wages', name: 'Salary & Wages', icon: '💼', type: 'income', description: 'Credits from salary, wages, or contract payments.', regex: '(SALARY|PAYROLL|WAGES|HRPAY|INCOME|PAYMENT\\s?FROM|COMPENSATION|TAPPI)' },
  { slug: 'refunds_reimbursements', name: 'Refunds & Reimbursements', icon: '↩️', type: 'income', description: 'Credits from refunds, cashback, or business reimbursements.', regex: '(REFUND|REVERSAL|CASHBACK|REV|REIMBURSE)' },
  { slug: 'healthcare', name: 'Healthcare', icon: '🏥', type: 'expense', description: 'Payments for hospitals, pharmacies, medical bills, or insurance.', regex: '(HOSPITAL|PHARMACY|MEDICAL|CLINIC|HEALTH|INSURANCE|NHIS)' },
  { slug: 'education', name: 'Education', icon: '🎓', type: 'expense', description: 'Tuition fees, online courses, learning materials, or academic services.', regex: '(SCHOOL|TUITION|COURSE|EDU|ACADEMY|E-LEARNING|TRAINING|BOOK)' },
  { slug: 'charity_donations', name: 'Charity & Donations', icon: '🙏', type: 'expense', description: 'Payments to charities, NGOs, religious contributions, or crowdfunding.', regex: '(CHURCH|MOSQUE|CHARITY|DONATION|TITHE|FOUNDATION|NGO)' },
  { slug: 'cash_withdrawal', name: 'Cash Withdrawal', icon: '💵', type: 'expense', description: 'ATM withdrawals or cash taken directly from bank branches.', regex: '(ATM|CASH\\s?WITHDRAWAL|BRANCH)' },
  { slug: 'family_support', name: 'Family Support', icon: '👨‍👩‍👧', type: 'expense', description: 'Regular or one-time financial support sent to family members or dependents.', regex: '(FAMILY|SUPPORT|ALLOWANCE|UPKEEP|DEPENDENTS|PARENTS|SIBLINGS|RELATIVE)' },
  { slug: 'beauty_personal_care', name: 'Beauty & Personal Care', icon: '💅', type: 'expense', description: 'Payments for salons, barbers, spas, cosmetics, or personal grooming.', regex: '(SALON|BARBER|BEAUTY|COSMETICS|HAIR|MAKEUP|SKINCARE|SPA|GROOMING|NAIL)' },
  { slug: 'gifts_social', name: 'Gifts & Social', icon: '🎁', type: 'expense', description: 'Spending on gifts, celebrations, parties, or social events.', regex: '(GIFT|PRESENT|CELEBRATION|PARTY|WEDDING|BIRTHDAY|SOCIAL|ANNIVERSARY)' },
  { slug: 'uncategorized', name: 'Uncategorized', icon: '❓', type: 'expense', description: 'Transactions that do not fit into any predefined category or require manual review.', regex: null },
];

async function seed() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);

  for (const cat of CATEGORIES) {
    await db
      .insert(CategorySchema)
      .values(cat)
      .onConflictDoUpdate({
        target: CategorySchema.slug,
        set: {
          name: cat.name,
          icon: cat.icon,
          description: cat.description,
          type: cat.type,
          regex: cat.regex,
          updatedAt: new Date(),
        },
      });
  }

  console.log(`Seeded/updated ${CATEGORIES.length} categories`);
  await pool.end();
}

seed().catch(console.error);
