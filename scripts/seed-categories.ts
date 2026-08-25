import 'reflect-metadata';
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { CategorySchema } from '../src/modules/category/category.schema';

// Regex patterns are matched against the sanitized *merchant name* only — not the
// full email body. Keep patterns specific so they don't fire on unrelated merchants.
// Order matters: more specific categories are inserted first so that if two patterns
// could match, the narrower one wins via the DB iteration order.
const CATEGORIES = [
  // ── Income ──────────────────────────────────────────────────────────────────
  {
    slug: 'salary_wages',
    name: 'Salary & Wages',
    icon: '💼',
    type: 'income',
    description: 'Credits from salary, wages, or contract payments.',
    regex: '\\b(salary|payroll|wages|hrpay|payslip|tappi|stipend)\\b',
  },
  {
    slug: 'refunds_reimbursements',
    name: 'Refunds & Reimbursements',
    icon: '↩️',
    type: 'income',
    description: 'Credits from refunds, cashback, or business reimbursements.',
    regex: '\\b(refund|reversal|cashback|reimburse)\\b',
  },

  // ── Specific digital services / subscriptions ────────────────────────────────
  {
    slug: 'subscriptions',
    name: 'Subscriptions',
    icon: '📺',
    type: 'expense',
    description: 'Recurring payments to digital services, streaming, or SaaS tools.',
    regex: '\\b(netflix|netflixcom|spotify|jetbrains|github|aws|amazon\\s*web|vercel|figma|notion|slack|1password|adobe|anthropic|claude|openai|chatgpt|paddle|microsoft|apple\\s*(music|tv|icloud|one)|youtube\\s*premium|dstv|gotv|showmax|hbo\\s*max|disney\\+?|paramount\\+?|crunchyroll|boomplay|audiomack|tidal)\\b',
  },

  // ── Mobile & Internet ────────────────────────────────────────────────────────
  {
    slug: 'mobile_internet',
    name: 'Mobile & Internet',
    icon: '📱',
    type: 'expense',
    description: 'Mobile top-ups, internet data, broadband, or telecom services.',
    regex: '\\b(mtn|airtel|glo|9mobile|vodafone|safaricom|telkom|data\\s*purchase|airtime|bundle|recharge)\\b',
  },

  // ── Dining & Food Delivery ───────────────────────────────────────────────────
  {
    slug: 'dining_food_delivery',
    name: 'Dining & Food Delivery',
    icon: '🍔',
    type: 'expense',
    description: 'Restaurants, cafés, takeaways, or online food delivery services.',
    regex: '\\b(glovo|uber\\s*eats|bolt\\s*food|jumia\\s*food|doordash|deliveroo|the\\s*place|mr\\s*biggs|chicken\\s*republic|sweet\\s*sensation|tantalizers|dominos?|pizza\\s*hut|kfc|mcdonald|burger\\s*king|kilimanjaro|coldstone|tastee|nandos?)\\b',
  },

  // ── Transport ────────────────────────────────────────────────────────────────
  {
    slug: 'transport',
    name: 'Transport',
    icon: '🚕',
    type: 'expense',
    description: 'Taxis, ride-hailing apps, buses, trains, or local commuting.',
    regex: '\\b(indrive|uber|bolt|taxify|lyft|shuttlers|move\\.ng|rida)\\b',
  },

  // ── Entertainment & Leisure ──────────────────────────────────────────────────
  {
    slug: 'entertainment_leisure',
    name: 'Entertainment & Leisure',
    icon: '🎮',
    type: 'expense',
    description: 'Movies, games, events, nightlife, or recreational activities.',
    regex: '\\b(silverbird|genesis\\s*cinema|filmhouse|imax|cinemahouse|steam|playstation|xbox|nintendo|epic\\s*games|riot\\s*games|ticket(master)?)\\b',
  },

  // ── Groceries ────────────────────────────────────────────────────────────────
  {
    slug: 'groceries',
    name: 'Groceries',
    icon: '🛒',
    type: 'expense',
    description: 'Supermarkets, convenience stores, or grocery delivery.',
    regex: '\\b(shoprite|park\\s*n\\s*shop|foodco|supermart|ebeano|market\\s*square|grocery|supermarket)\\b',
  },

  // ── Retail & E-Commerce ──────────────────────────────────────────────────────
  {
    slug: 'retail_ecommerce',
    name: 'Retail & E-commerce',
    icon: '🛍️',
    type: 'expense',
    description: 'Online or physical retail stores (clothing, electronics, general shopping).',
    regex: '\\b(jumia|konga|amazon|aliexpress|shein|ebay|payporte|jiji|fashion|boutique|store)\\b',
  },

  // ── Fuel & Auto ──────────────────────────────────────────────────────────────
  {
    slug: 'fuel_auto',
    name: 'Fuel & Auto',
    icon: '⛽',
    type: 'expense',
    description: 'Fuel, car maintenance, parking, or tolls.',
    regex: '\\b(filling\\s*station|fuel|petrol|lubricant|mechanic|car\\s*wash|tyre|coscharis)\\b',
  },

  // ── Travel ───────────────────────────────────────────────────────────────────
  {
    slug: 'travel',
    name: 'Travel',
    icon: '✈️',
    type: 'expense',
    description: 'Flights, hotels, travel agencies, or vacation expenses.',
    regex: '\\b(flight|airways|hotel|booking\\.com|airbnb|expedia|wakanow|travelstart|travelbox)\\b',
  },

  // ── Utilities ────────────────────────────────────────────────────────────────
  {
    slug: 'utilities',
    name: 'Utilities',
    icon: '💡',
    type: 'expense',
    description: 'Electricity, water, gas, or household services.',
    regex: '\\b(phcn|ekedc|ikedc|aedc|jedc|phed|electricity|water\\s*bill|gas\\s*bill|nepa|kplc|umeme)\\b',
  },

  // ── Bank Charges ─────────────────────────────────────────────────────────────
  {
    slug: 'bank_charges',
    name: 'Bank Charges',
    icon: '🏦',
    type: 'expense',
    description: 'Service fees, maintenance, ATM fees, or other bank deductions.',
    regex: '\\b(sms\\s*(alert\\s*)?(charge|fee)|card\\s*maintenance|account\\s*maintenance|stamp\\s*duty|interest\\s*charge|commission\\s*on\\s*turnover|cow\\s*charge|cot\\s*charge|vat\\s*charge|bank\\s*charge|atm\\s*fee)\\b',
  },

  // ── Currency Conversion ───────────────────────────────────────────────────────
  {
    slug: 'currency_conversion',
    name: 'Currency Conversion',
    icon: '💱',
    type: 'expense',
    description: 'FX transactions or fund conversions between currencies.',
    regex: '\\b(fcy\\s*conversion|currency\\s*conv|fx\\s*conversion|forex|exchange)\\b',
  },

  // ── Self-Transfer ────────────────────────────────────────────────────────────
  // Applied by transfer-detection when a same-currency transaction is matched (or
  // confirmed) as money moving between the user's own accounts — not spend or
  // income. The regex only catches explicit narrations; most self-transfers are
  // tagged after the fact by TransferDetectionService, not by this pattern.
  {
    slug: 'self_transfer',
    name: 'Self-Transfer',
    icon: '🔁',
    type: 'expense',
    description: 'Money moved between your own accounts — not counted as spend or income.',
    regex: '\\b(own\\s*account|self\\s*transfer|to\\s*self)\\b',
  },

  // ── Cash Withdrawal ───────────────────────────────────────────────────────────
  {
    slug: 'cash_withdrawal',
    name: 'Cash Withdrawal',
    icon: '💵',
    type: 'expense',
    description: 'ATM withdrawals or cash from bank branches.',
    regex: '\\b(atm\\s*withdrawal|cash\\s*withdrawal|atm\\s*cash)\\b',
  },

  // ── Investment ────────────────────────────────────────────────────────────────
  {
    slug: 'investment',
    name: 'Investment',
    icon: '📈',
    type: 'expense',
    description: 'Investment platforms, stocks, mutual funds, or savings-linked products.',
    regex: '\\b(piggyvest|cowrywise|bamboo|trove|rise|stash|chaka|risevest|mutual\\s*fund|wealth\\s*mgmt)\\b',
  },

  // ── Savings ───────────────────────────────────────────────────────────────────
  {
    slug: 'savings',
    name: 'Savings',
    icon: '💰',
    type: 'expense',
    description: 'Transfers to savings accounts, locked funds, or target savings.',
    regex: '\\b(target\\s*savings|lock\\s*funds|fixed\\s*deposit|savings\\s*plan)\\b',
  },

  // ── Rent & Housing ────────────────────────────────────────────────────────────
  {
    slug: 'rent_housing',
    name: 'Rent & Housing',
    icon: '🏠',
    type: 'expense',
    description: 'Rent, housing fees, landlord transfers, or property-related expenses.',
    regex: '\\b(rent|landlord|lease|accommodation|property\\s*agent)\\b',
  },

  // ── Healthcare ────────────────────────────────────────────────────────────────
  {
    slug: 'healthcare',
    name: 'Healthcare',
    icon: '🏥',
    type: 'expense',
    description: 'Hospitals, pharmacies, medical bills, or health insurance.',
    regex: '\\b(hospital|pharmacy|clinic|medical|health\\s*insurance|nhis|hmo)\\b',
  },

  // ── Education ────────────────────────────────────────────────────────────────
  {
    slug: 'education',
    name: 'Education',
    icon: '🎓',
    type: 'expense',
    description: 'Tuition, online courses, learning materials, or academic services.',
    regex: '\\b(tuition|school\\s*fee|academy|udemy|coursera|edx|pluralsight|skillshare)\\b',
  },

  // ── Charity & Donations ───────────────────────────────────────────────────────
  {
    slug: 'charity_donations',
    name: 'Charity & Donations',
    icon: '🙏',
    type: 'expense',
    description: 'Charities, NGOs, religious contributions, or crowdfunding.',
    regex: '\\b(charity|donation|tithe|offering|foundation|ngo|red\\s*cross|unicef)\\b',
  },

  // ── Family Support ────────────────────────────────────────────────────────────
  {
    slug: 'family_support',
    name: 'Family Support',
    icon: '👨‍👩‍👧',
    type: 'expense',
    description: 'Financial support sent to family members or dependents.',
    regex: '\\b(upkeep|allowance\\s*(?:to|for)|family\\s*support)\\b',
  },

  // ── Beauty & Personal Care ────────────────────────────────────────────────────
  {
    slug: 'beauty_personal_care',
    name: 'Beauty & Personal Care',
    icon: '💅',
    type: 'expense',
    description: 'Salons, barbers, spas, cosmetics, or personal grooming.',
    regex: '\\b(salon|barber|spa|grooming|nail\\s*art|cosmetics|skincare)\\b',
  },

  // ── Gifts & Social ────────────────────────────────────────────────────────────
  {
    slug: 'gifts_social',
    name: 'Gifts & Social',
    icon: '🎁',
    type: 'expense',
    description: 'Gifts, celebrations, parties, or social events.',
    regex: '\\b(gift|birthday\\s*present|anniversary\\s*gift|celebration)\\b',
  },

  // ── Business Payment ──────────────────────────────────────────────────────────
  {
    slug: 'business_payment',
    name: 'Business Payment',
    icon: '🏢',
    type: 'expense',
    description: 'Payments to businesses for goods/services not covered by other categories.',
    regex: null,
  },

  // ── Peer-to-Peer Transfer ─────────────────────────────────────────────────────
  // Listed last — only fires if no other category matched. Regex kept narrow to avoid
  // catching business merchants. Person-name transfers fall through to AI classification.
  {
    slug: 'peer_to_peer_transfer',
    name: 'Peer-to-Peer Transfer',
    icon: '👤',
    type: 'expense',
    description: 'Money sent directly to individuals via bank transfer or P2P apps.',
    regex: null,
  },

  // ── Uncategorized ─────────────────────────────────────────────────────────────
  {
    slug: 'uncategorized',
    name: 'Uncategorized',
    icon: '❓',
    type: 'expense',
    description: 'Transactions that do not fit any predefined category.',
    regex: null,
  },
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
