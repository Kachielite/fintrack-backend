import 'dotenv/config';
import bcrypt from 'bcrypt';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { eq, ilike } from 'drizzle-orm';
import { UserSchema } from '../src/modules/user/user.schema';
import { TransactionSchema } from '../src/modules/transaction/transaction.schema';
import { BudgetSchema } from '../src/modules/budget/budget.schema';
import { BankSchema } from '../src/modules/bank/bank.schema';

// ─── Demo credentials ────────────────────────────────────────────────────────
export const DEMO_EMAIL = 'demo@fintrack.app';
export const DEMO_PASSWORD = 'Demo1234!';

type NewTransaction = typeof TransactionSchema.$inferInsert;
type NewBudget = typeof BudgetSchema.$inferInsert;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function d(year: number, month: number, day: number, hour = 10, min = 0): Date {
  return new Date(year, month, day, hour, min);
}
function txn(
  userId: number,
  bankId: number | null,
  date: Date,
  merchant: string,
  category: string,
  amount: number, // negative = debit, positive = credit
  status: 'verified' | 'unverified' | 'corrected' = 'verified',
  ref?: string,
): NewTransaction {
  return {
    userId,
    bankId,
    emailConnectionId: null,
    parserTemplateId: null,
    gmailMessageId: null,
    merchant,
    category,
    transactionType: amount > 0 ? 'credit' : 'debit',
    amount,
    currency: 'NGN',
    refAmount: amount,
    refCurrency: 'NGN',
    exchangeRateUsed: null,
    transactionDate: date,
    status,
    originalMerchant: merchant,
    originalCategory: category,
    reference: ref ?? null,
    balance: null,
  };
}

async function seedDemo() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);

  console.log('🌱 Seeding demo user...');

  // ── 1. Find or create demo user ───────────────────────────────────────────
  let [user] = await db
    .select()
    .from(UserSchema)
    .where(eq(UserSchema.email, DEMO_EMAIL))
    .limit(1);

  const hash = await bcrypt.hash(DEMO_PASSWORD, 12);

  if (!user) {
    [user] = await db
      .insert(UserSchema)
      .values({
        email: DEMO_EMAIL,
        firstName: 'Alex',
        lastName: 'Adeyemi',
        refCurrency: 'NGN',
        advisorTone: 'warm',
        goalType: 'save_more',
        incomeRange: '200000-500000',
        payFrequency: 'monthly',
        onboardingComplete: true,
        demoPasswordHash: hash,
        dataRetentionMonths: 12,
        planTier: 'free',
      } as any)
      .returning();
    console.log(`  ✓ Created demo user (id=${user.id})`);
  } else {
    await db
      .update(UserSchema)
      .set({
        firstName: 'Alex',
        lastName: 'Adeyemi',
        refCurrency: 'NGN',
        advisorTone: 'warm',
        goalType: 'save_more',
        incomeRange: '200000-500000',
        payFrequency: 'monthly',
        onboardingComplete: true,
        demoPasswordHash: hash,
        dataRetentionMonths: 12,
        updatedAt: new Date(),
      } as any)
      .where(eq(UserSchema.id, user.id));
    console.log(`  ✓ Updated demo user (id=${user.id})`);
  }

  const userId = user.id;

  // ── 2. Find bank IDs ──────────────────────────────────────────────────────
  const [gtbank] = await db
    .select({ id: BankSchema.id })
    .from(BankSchema)
    .where(ilike(BankSchema.name, '%gtbank%'))
    .limit(1);
  const [access] = await db
    .select({ id: BankSchema.id })
    .from(BankSchema)
    .where(ilike(BankSchema.name, '%access%'))
    .limit(1);

  const bankA = gtbank?.id ?? null;
  const bankB = access?.id ?? null;

  // ── 3. Wipe existing demo data ────────────────────────────────────────────
  await db.delete(TransactionSchema).where(eq(TransactionSchema.userId, userId));
  await db.delete(BudgetSchema).where(eq(BudgetSchema.userId, userId));
  console.log('  ✓ Cleared existing demo data');

  // ── 4. Build transactions ─────────────────────────────────────────────────
  //
  // 5 full months (Jan–Apr 2026) + partial May 2026 (up to day 12).
  // Budgets are for the current month (May 2026). Spending is calibrated to
  // show interesting statuses: OVER (dining), WARNING (subscriptions),
  // HEALTHY (groceries, transport, entertainment, mobile).
  //
  const transactions: NewTransaction[] = [

    // ─── January 2026 ──────────────────────────────────────────────────────
    txn(userId, bankB, d(2026, 0, 1, 8, 0),  'Netflix',              'subscriptions',        -4600),
    txn(userId, bankB, d(2026, 0, 1, 8, 5),  'Spotify',              'subscriptions',        -3200),
    txn(userId, bankB, d(2026, 0, 1, 8,10),  'DSTV Compact',         'subscriptions',       -12500),
    txn(userId, bankA, d(2026, 0, 2, 9, 0),  'MTN Nigeria',          'mobile_internet',      -5000),
    txn(userId, bankA, d(2026, 0, 3,12, 0),  'Shoprite Ikeja',       'groceries',           -22500),
    txn(userId, bankA, d(2026, 0, 4,17, 0),  'Uber Nigeria',         'transport',            -3500),
    txn(userId, bankA, d(2026, 0, 6,13, 0),  'Dominos Pizza',        'dining_food_delivery', -6500),
    txn(userId, bankA, d(2026, 0, 8,18, 0),  'Bolt',                 'transport',            -2100),
    txn(userId, bankA, d(2026, 0,10,11, 0),  'EKEDC Electricity',    'utilities',           -24500),
    txn(userId, bankA, d(2026, 0,12,14, 0),  'Spar Nigeria',         'groceries',           -15800),
    txn(userId, bankA, d(2026, 0,15,13, 0),  'Chicken Republic',     'dining_food_delivery', -4200),
    txn(userId, bankA, d(2026, 0,15,19, 0),  'Uber Nigeria',         'transport',            -4200),
    txn(userId, bankA, d(2026, 0,20,15, 0),  'Silverbird Cinema',    'entertainment_leisure',-7500),
    txn(userId, bankA, d(2026, 0,21,12, 0),  'Cold Stone Creamery',  'dining_food_delivery', -3800),
    txn(userId, bankA, d(2026, 0,22,17, 0),  'Uber Nigeria',         'transport',            -2800),
    txn(userId, bankA, d(2026, 0,24,10, 0),  'Justrite Superstore',  'groceries',           -18200),
    txn(userId, bankB, d(2026, 0,25, 9, 0),  'Pinnacle Technologies','salary_wages',        355000, 'verified', 'SAL/JAN2026'),

    // ─── February 2026 ─────────────────────────────────────────────────────
    txn(userId, bankB, d(2026, 1, 1, 8, 0),  'Netflix',              'subscriptions',        -4600),
    txn(userId, bankB, d(2026, 1, 1, 8, 5),  'Spotify',              'subscriptions',        -3200),
    txn(userId, bankB, d(2026, 1, 1, 8,10),  'DSTV Compact',         'subscriptions',       -12500),
    txn(userId, bankA, d(2026, 1, 1, 9, 0),  'Airtel Data',          'mobile_internet',      -4000),
    txn(userId, bankA, d(2026, 1, 2,12, 0),  'Shoprite Ikeja',       'groceries',           -25000),
    txn(userId, bankA, d(2026, 1, 3,17, 0),  'Uber Nigeria',         'transport',            -3200),
    txn(userId, bankA, d(2026, 1, 5,13, 0),  'Dominos Pizza',        'dining_food_delivery', -8500),
    txn(userId, bankA, d(2026, 1, 8,11, 0),  'EKEDC Electricity',    'utilities',           -22800),
    txn(userId, bankA, d(2026, 1, 9,18, 0),  'Bolt',                 'transport',            -1800),
    txn(userId, bankA, d(2026, 1,13,13, 0),  'KFC Ikeja',            'dining_food_delivery', -5200),
    txn(userId, bankA, d(2026, 1,14,12, 0),  'Tunde Bakare',         'peer_to_peer_transfer',-20000),
    txn(userId, bankA, d(2026, 1,14,19, 0),  'TFC Restaurant',       'dining_food_delivery',-11000),
    txn(userId, bankA, d(2026, 1,16,17, 0),  'Uber Nigeria',         'transport',            -5500),
    txn(userId, bankA, d(2026, 1,18,10, 0),  'GTBank ATM',           'cash_withdrawal',     -30000),
    txn(userId, bankA, d(2026, 1,20,12, 0),  'Chicken Republic',     'dining_food_delivery', -4800),
    txn(userId, bankA, d(2026, 1,22,14, 0),  'Spar Nigeria',         'groceries',           -17500),
    txn(userId, bankA, d(2026, 1,23,17, 0),  'Uber Nigeria',         'transport',            -3200),
    txn(userId, bankA, d(2026, 1,25,10, 0),  'Justrite Superstore',  'groceries',           -14800),
    txn(userId, bankB, d(2026, 1,25, 9, 0),  'Pinnacle Technologies','salary_wages',        358000, 'verified', 'SAL/FEB2026'),

    // ─── March 2026 ────────────────────────────────────────────────────────
    txn(userId, bankB, d(2026, 2, 1, 8, 0),  'Netflix',              'subscriptions',        -4600),
    txn(userId, bankB, d(2026, 2, 1, 8, 5),  'Spotify',              'subscriptions',        -3200),
    txn(userId, bankB, d(2026, 2, 1, 8,10),  'DSTV Compact',         'subscriptions',       -12500),
    txn(userId, bankA, d(2026, 2, 1, 9, 0),  'MTN Nigeria',          'mobile_internet',      -5000),
    txn(userId, bankA, d(2026, 2, 3,17, 0),  'Uber Nigeria',         'transport',            -4200),
    txn(userId, bankA, d(2026, 2, 4,12, 0),  'Shoprite Ikeja',       'groceries',           -19500),
    txn(userId, bankA, d(2026, 2, 7,13, 0),  'Dominos Pizza',        'dining_food_delivery', -7200),
    txn(userId, bankA, d(2026, 2,10,18, 0),  'Bolt',                 'transport',            -2500),
    txn(userId, bankA, d(2026, 2,11,11, 0),  'EKEDC Electricity',    'utilities',           -27000),
    txn(userId, bankA, d(2026, 2,15,11, 0),  'Reddington Hospital',  'healthcare',          -15000),
    txn(userId, bankA, d(2026, 2,15,14, 0),  'PZ Foods',             'groceries',           -12800),
    txn(userId, bankA, d(2026, 2,17,16, 0),  'Uber Nigeria',         'transport',            -3800),
    txn(userId, bankA, d(2026, 2,18,12, 0),  'Cold Stone Creamery',  'dining_food_delivery', -4500),
    txn(userId, bankA, d(2026, 2,24,17, 0),  'Lagos BRT',            'transport',             -600),
    txn(userId, bankA, d(2026, 2,25,12, 0),  'Spar Nigeria',         'groceries',           -21000),
    txn(userId, bankB, d(2026, 2,25, 9, 0),  'Pinnacle Technologies','salary_wages',        362000, 'verified', 'SAL/MAR2026'),
    txn(userId, bankA, d(2026, 2,28,12, 0),  'Chicken Republic',     'dining_food_delivery', -5800),

    // ─── April 2026 ────────────────────────────────────────────────────────
    txn(userId, bankB, d(2026, 3, 1, 8, 0),  'Netflix',              'subscriptions',        -4600),
    txn(userId, bankB, d(2026, 3, 1, 8, 5),  'Spotify',              'subscriptions',        -3200),
    txn(userId, bankB, d(2026, 3, 1, 8,10),  'DSTV Compact',         'subscriptions',       -12500),
    txn(userId, bankA, d(2026, 3, 1, 9, 0),  'MTN Nigeria',          'mobile_internet',      -5000),
    txn(userId, bankA, d(2026, 3, 3,12, 0),  'Shoprite Ikeja',       'groceries',           -28000),
    txn(userId, bankA, d(2026, 3, 4,17, 0),  'Uber Nigeria',         'transport',            -4800),
    txn(userId, bankA, d(2026, 3, 5,13, 0),  'Seun Adewale',         'peer_to_peer_transfer',-50000),
    txn(userId, bankA, d(2026, 3, 5,14, 0),  'Dominos Pizza',        'dining_food_delivery', -9500),
    txn(userId, bankA, d(2026, 3, 9,11, 0),  'EKEDC Electricity',    'utilities',           -25500),
    txn(userId, bankA, d(2026, 3, 9,12, 0),  'Oando Gas Station',    'fuel_auto',            -8500),
    txn(userId, bankA, d(2026, 3,10,18, 0),  'Bolt',                 'transport',            -2200),
    txn(userId, bankA, d(2026, 3,12,13, 0),  'KFC Ikeja',            'dining_food_delivery', -6200),
    txn(userId, bankA, d(2026, 3,12,15, 0),  'Silverbird Cinema',    'entertainment_leisure',-8500),
    txn(userId, bankA, d(2026, 3,14,12, 0),  'Justrite Superstore',  'groceries',           -16500),
    txn(userId, bankA, d(2026, 3,17,16, 0),  'Uber Nigeria',         'transport',            -5200),
    txn(userId, bankA, d(2026, 3,19,14, 0),  'TFC Restaurant',       'dining_food_delivery',-14500),
    txn(userId, bankA, d(2026, 3,19,16, 0),  'The Zone Lagos',       'entertainment_leisure',-5500),
    txn(userId, bankA, d(2026, 3,20,10, 0),  'GTBank ATM',           'cash_withdrawal',     -40000),
    txn(userId, bankA, d(2026, 3,23,14, 0),  'Spar Nigeria',         'groceries',           -19800),
    txn(userId, bankA, d(2026, 3,24,17, 0),  'Uber Nigeria',         'transport',            -3500),
    txn(userId, bankA, d(2026, 3,26,12, 0),  'Cold Stone Creamery',  'dining_food_delivery', -4800),
    txn(userId, bankB, d(2026, 3,25, 9, 0),  'Pinnacle Technologies','salary_wages',        370000, 'verified', 'SAL/APR2026'),
    txn(userId, bankA, d(2026, 3,28,14, 0),  'Medexpress Pharmacy',  'healthcare',           -8500),

    // ─── May 2026 (partial – day 12) ───────────────────────────────────────
    // Subscriptions (total 12,800 → budget 15,000 = 85% ⚠ WARNING)
    txn(userId, bankB, d(2026, 4, 1, 8, 0),  'Netflix',              'subscriptions',        -4600),
    txn(userId, bankB, d(2026, 4, 1, 8, 5),  'Spotify',              'subscriptions',        -3200),
    txn(userId, bankB, d(2026, 4, 1, 8,10),  'DSTV Compact',         'subscriptions',        -5000),

    // Mobile (total 4,000 → budget 8,000 = 50% ✓ HEALTHY)
    txn(userId, bankA, d(2026, 4, 1, 9, 0),  'MTN Nigeria',          'mobile_internet',      -4000),

    // Transport (total 13,000 → budget 25,000 = 52% ✓ HEALTHY)
    txn(userId, bankA, d(2026, 4, 1,18, 0),  'Uber Nigeria',         'transport',            -3500),
    txn(userId, bankA, d(2026, 4, 3,17, 0),  'Bolt',                 'transport',            -1800),
    txn(userId, bankA, d(2026, 4, 5,16, 0),  'Uber Nigeria',         'transport',            -4200),
    txn(userId, bankA, d(2026, 4, 8,11, 0),  'Lagos BRT',            'transport',             -600),
    txn(userId, bankA, d(2026, 4,10,17, 0),  'Uber Nigeria',         'transport',            -2900),

    // Groceries (total 38,000 → budget 60,000 = 63% ✓ HEALTHY)
    txn(userId, bankA, d(2026, 4, 2,12, 0),  'Shoprite Ikeja',       'groceries',           -18500),
    txn(userId, bankA, d(2026, 4, 7,14, 0),  'Justrite Superstore',  'groceries',           -11200),
    txn(userId, bankA, d(2026, 4,10,11, 0),  'Spar Nigeria',         'groceries',            -8300),

    // Dining (total 52,000 → budget 45,000 = 115% 🔴 OVER)
    txn(userId, bankA, d(2026, 4, 1,13, 0),  'Dominos Pizza',        'dining_food_delivery', -8500),
    txn(userId, bankA, d(2026, 4, 3,13, 0),  'Chicken Republic',     'dining_food_delivery', -4200),
    txn(userId, bankA, d(2026, 4, 5,12, 0),  'Jumia Food',           'dining_food_delivery', -6800),
    txn(userId, bankA, d(2026, 4, 8,15, 0),  'Cold Stone Creamery',  'dining_food_delivery', -5500),
    txn(userId, bankA, d(2026, 4,10,20, 0),  'TFC Restaurant',       'dining_food_delivery',-12000),
    txn(userId, bankA, d(2026, 4,11,13, 0),  'KFC Ikeja',            'dining_food_delivery', -7200),
    txn(userId, bankA, d(2026, 4,12,12, 0),  'Chicken Republic',     'dining_food_delivery', -7800),

    // Entertainment (total 11,000 → budget 30,000 = 37% ✓ HEALTHY)
    txn(userId, bankA, d(2026, 4, 4,16, 0),  'Silverbird Cinema',    'entertainment_leisure',-7500),
    txn(userId, bankA, d(2026, 4, 9,15, 0),  'The Zone Lagos',       'entertainment_leisure',-3500),

    // Cash
    txn(userId, bankA, d(2026, 4, 5,10, 0),  'GTBank ATM',           'cash_withdrawal',     -20000),

    // 2 unverified transactions to showcase the review feature
    txn(userId, bankA, d(2026, 4,11,16, 0),  'AWOOF Superstore',     'uncategorized',       -12500, 'unverified'),
    txn(userId, bankA, d(2026, 4,12, 9, 0),  'Bolt Food',            'uncategorized',        -8000, 'unverified'),
  ];

  const inserted = await db.insert(TransactionSchema).values(transactions).returning({ id: TransactionSchema.id });
  console.log(`  ✓ Inserted ${inserted.length} transactions`);

  // ── 5. Create budgets ─────────────────────────────────────────────────────
  const budgets: NewBudget[] = [
    {
      userId,
      category: 'dining_food_delivery',
      limitAmount: 45000,
      currency: 'NGN',
      periodType: 'monthly',
      isActive: true,
      isSuggestedByAi: true,
      habitDescription: "You've been spending ₦45k–₦58k on dining each month, up from ₦30k six months ago. Limit set at ₦45k to help rein in a creeping trend.",
    },
    {
      userId,
      category: 'subscriptions',
      limitAmount: 15000,
      currency: 'NGN',
      periodType: 'monthly',
      isActive: true,
      isSuggestedByAi: true,
      habitDescription: "You consistently spend ₦20,300 on subscriptions every month — Netflix, Spotify and DSTV. Limit set at ₦15k to flag any new additions.",
    },
    {
      userId,
      category: 'groceries',
      limitAmount: 60000,
      currency: 'NGN',
      periodType: 'monthly',
      isActive: true,
      isSuggestedByAi: true,
      habitDescription: "Grocery spending runs ₦46k–₦64k per month, averaging ₦54k over 5 months. Limit set at ₦60k — a realistic ceiling that keeps you on track.",
    },
    {
      userId,
      category: 'transport',
      limitAmount: 25000,
      currency: 'NGN',
      periodType: 'monthly',
      isActive: true,
      isSuggestedByAi: true,
      habitDescription: "Transport costs average ₦14k/month, mostly Uber and Bolt. Limit set at ₦25k to give breathing room without encouraging overspend.",
    },
    {
      userId,
      category: 'entertainment_leisure',
      limitAmount: 30000,
      currency: 'NGN',
      periodType: 'monthly',
      isActive: true,
      isSuggestedByAi: true,
      habitDescription: "You spend ₦0–₦14k on entertainment — mostly cinemas. Limit set at ₦30k to give freedom while keeping savings goals in sight.",
    },
    {
      userId,
      category: 'mobile_internet',
      limitAmount: 8000,
      currency: 'NGN',
      periodType: 'monthly',
      isActive: true,
      isSuggestedByAi: true,
      habitDescription: "Data and airtime run ₦4k–₦5k/month reliably. Limit set at ₦8k to cover any spike months.",
    },
  ];

  await db.insert(BudgetSchema).values(budgets);
  console.log(`  ✓ Inserted ${budgets.length} budgets`);

  console.log('');
  console.log('✅ Demo seed complete!');
  console.log(`   Email:    ${DEMO_EMAIL}`);
  console.log(`   Password: ${DEMO_PASSWORD}`);
  console.log('');

  await pool.end();
}

seedDemo().catch((err) => {
  console.error(err);
  process.exit(1);
});
