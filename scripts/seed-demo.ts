import 'reflect-metadata';
import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import Database from '../src/common/lib/database';
import { hashPassword } from '../src/common/utils/password-encoder';
import { UserSchema } from '../src/modules/user/user.schema';
import AuthRepositoryImpl from '../src/modules/auth/auth.repository';
import { AuthProviderEnum } from '../src/modules/auth/auth.enum';
import { BankSchema } from '../src/modules/bank/bank.schema';
import { AccountSchema } from '../src/modules/account/account.schema';
import { TransactionSchema } from '../src/modules/transaction/transaction.schema';
import { BudgetSchema } from '../src/modules/budget/budget.schema';
import { GoalSchema } from '../src/modules/goal/goal.schema';
import { InsightSchema } from '../src/modules/insight/insight.schema';
import { NotificationSchema } from '../src/modules/notification/notification.schema';
import { TransferLinkSchema } from '../src/modules/account/transfer-link.schema';
import { AccountTransferRuleSchema } from '../src/modules/account/account-transfer-rule.schema';
import { GoalTypeEnum } from '../src/modules/user/user.enum';
import { InsightTypeEnum } from '../src/modules/insight/insight.enum';
import TransactionRepositoryImpl from '../src/modules/transaction/transaction.repository';
import TransferLinkRepositoryImpl from '../src/modules/account/transfer-link.repository';
import AccountTransferRuleRepositoryImpl from '../src/modules/account/account-transfer-rule.repository';
import ExchangeRateRepositoryImpl from '../src/modules/exchange-rate/exchange-rate.repository';
import ExchangeRateService from '../src/modules/exchange-rate/exchange-rate.service';
import NotificationRepositoryImpl from '../src/modules/notification/notification.repository';
import NotificationService from '../src/modules/notification/notification.service';
import TransferDetectionService from '../src/modules/account/transfer-detection.service';
import { ITransaction } from '../src/modules/transaction/transaction.interface';

// ─── Demo credentials ────────────────────────────────────────────────────────
export const DEMO_EMAIL = 'demo@fintrack.app';
export const DEMO_PASSWORD = 'Demo1234!';

const today = new Date();

type NewTransaction = typeof TransactionSchema.$inferInsert;
type NewBudget = typeof BudgetSchema.$inferInsert;
type NewGoal = typeof GoalSchema.$inferInsert;
type NewInsight = typeof InsightSchema.$inferInsert;
type NewNotification = typeof NotificationSchema.$inferInsert;

// ─── Date helpers ────────────────────────────────────────────────────────────
// Anchors every date to "today" at seed-run time, so the demo always looks
// current no matter when it's run: monthsAgo=0 is the (possibly partial)
// current month, 1..5 are full prior months.
function monthDate(monthsAgo: number, day: number, hour = 12, min = 0): Date | null {
  const anchor = new Date(today.getFullYear(), today.getMonth() - monthsAgo, day, hour, min);
  if (monthsAgo === 0 && anchor.getTime() > today.getTime()) return null; // hasn't happened yet this month
  return anchor;
}
function daysAgo(n: number, hour = 12, min = 0): Date {
  const dt = new Date(today);
  dt.setDate(dt.getDate() - n);
  dt.setHours(hour, min, 0, 0);
  return dt;
}

async function seedDemo() {
  const db = new Database();

  console.log('🌱 Seeding demo user...');

  // ── 1. Find or create demo user ───────────────────────────────────────────
  let [user] = await db.client.select().from(UserSchema).where(eq(UserSchema.email, DEMO_EMAIL)).limit(1);

  const hash = await hashPassword(DEMO_PASSWORD);
  const profile = {
    firstName: 'Alex',
    lastName: 'Adeyemi',
    refCurrency: 'NGN',
    advisorTone: 'warm',
    goalType: 'save_more',
    incomeRange: '200000-500000',
    payFrequency: 'monthly',
    onboardingComplete: true,
    passwordHash: hash,
    dataRetentionMonths: 12,
  };

  if (!user) {
    [user] = await db.client
      .insert(UserSchema)
      .values({ email: DEMO_EMAIL, planTier: 'free', ...profile } as any)
      .returning();
    console.log(`  ✓ Created demo user (id=${user.id})`);
  } else {
    await db.client
      .update(UserSchema)
      .set({ ...profile, updatedAt: new Date() } as any)
      .where(eq(UserSchema.id, user.id));
    console.log(`  ✓ Updated demo user (id=${user.id})`);
  }

  const authRepository = new AuthRepositoryImpl(db);
  const existingProvider = await authRepository.findAuthProvider({
    provider: AuthProviderEnum.PASSWORD,
    providerUserId: user.email,
  });
  if (!existingProvider) {
    await authRepository.createAuthProvider({
      userId: user.id,
      provider: AuthProviderEnum.PASSWORD,
      providerUserId: user.email,
    });
    console.log('  ✓ Linked password auth provider');
  }

  const userId = user.id;

  // ── 2. Wipe every trace of this demo user's prior data ────────────────────
  // Full reset, child-to-parent, so re-running is always safe. Deliberately
  // leaves users/banks/categories/email_connections alone — this only clears
  // data that belongs to *this* demo user's financial history.
  await db.client.delete(TransferLinkSchema).where(eq(TransferLinkSchema.userId, userId));
  await db.client.delete(AccountTransferRuleSchema).where(eq(AccountTransferRuleSchema.userId, userId));
  await db.client.delete(NotificationSchema).where(eq(NotificationSchema.userId, userId));
  await db.client.delete(InsightSchema).where(eq(InsightSchema.userId, userId));
  await db.client.delete(GoalSchema).where(eq(GoalSchema.userId, userId));
  await db.client.delete(BudgetSchema).where(eq(BudgetSchema.userId, userId));
  await db.client.delete(TransactionSchema).where(eq(TransactionSchema.userId, userId));
  await db.client.delete(AccountSchema).where(eq(AccountSchema.userId, userId));
  console.log('  ✓ Cleared existing demo data (transactions, accounts, budgets, goals, insights, notifications, transfer links)');

  // ── 3. Resolve banks and create accounts ──────────────────────────────────
  // The `accounts` table was added after this script was first written, so
  // transactions used to be seeded with a bare bankId and no account at all.
  // Accounts are now created explicitly, the same way real ingestion resolves
  // them (one per bank+currency pair), and every transaction below is
  // attributed to one.
  const banks = await db.client
    .select({ id: BankSchema.id, shortCode: BankSchema.shortCode })
    .from(BankSchema)
    .where(inArray(BankSchema.shortCode, ['access', 'kuda', 'wise']));
  const bankByCode = new Map(banks.map((b) => [b.shortCode, b.id]));
  const accessBankId = bankByCode.get('access') ?? null;
  const kudaBankId = bankByCode.get('kuda') ?? null;
  const wiseBankId = bankByCode.get('wise') ?? null;

  const [accessAccount] = await db.client
    .insert(AccountSchema)
    .values({ userId, bankId: accessBankId, currency: 'NGN', label: 'Access Bank (NGN)', accountNumberMask: '**** 4821' })
    .returning();
  const [kudaAccount] = await db.client
    .insert(AccountSchema)
    .values({ userId, bankId: kudaBankId, currency: 'NGN', label: 'Kuda Bank (NGN)', accountNumberMask: '**** 0193' })
    .returning();
  const [wiseAccount] = await db.client
    .insert(AccountSchema)
    .values({ userId, bankId: wiseBankId, currency: 'GBP', label: 'Wise (GBP)', accountNumberMask: '**** 7740' })
    .returning();
  console.log(`  ✓ Created 3 accounts (Access Bank NGN, Kuda Bank NGN, Wise GBP)`);

  // ── 4. Build 6 months of transaction history ──────────────────────────────
  //
  // A repeating monthly template (subscriptions, groceries, dining, transport,
  // utilities, salary...) is replayed for the current month and the 5 before
  // it, with a per-month multiplier so dining/subscriptions visibly creep up
  // toward "now" — enough history for the rolling-average comparison and
  // 6-month trend chart, not just a single flat month. `monthDate` drops any
  // day that hasn't happened yet in the current (possibly partial) month, so
  // this always looks right regardless of what day it's run on.
  //
  // Cash withdrawals and entertainment route through Kuda so it isn't an
  // empty account; everything else defaults to Access.
  type Line = {
    day: number;
    hour?: number;
    min?: number;
    merchant: string;
    category: string;
    amount: number; // negative = debit, positive = credit
  };
  const KUDA_CATEGORIES = new Set(['cash_withdrawal', 'entertainment_leisure']);

  const monthlyTemplate: Line[] = [
    { day: 1, hour: 8, min: 0, merchant: 'Netflix', category: 'subscriptions', amount: -4600 },
    { day: 1, hour: 8, min: 5, merchant: 'Spotify', category: 'subscriptions', amount: -3200 },
    { day: 1, hour: 8, min: 10, merchant: 'DSTV Compact', category: 'subscriptions', amount: -9500 },
    { day: 2, hour: 9, min: 0, merchant: 'MTN Nigeria', category: 'mobile_internet', amount: -4800 },
    { day: 3, hour: 12, min: 0, merchant: 'Shoprite Ikeja', category: 'groceries', amount: -21000 },
    { day: 4, hour: 17, min: 0, merchant: 'Uber Nigeria', category: 'transport', amount: -3800 },
    { day: 6, hour: 13, min: 0, merchant: 'Dominos Pizza', category: 'dining_food_delivery', amount: -7500 },
    { day: 8, hour: 18, min: 0, merchant: 'Bolt', category: 'transport', amount: -2200 },
    { day: 9, hour: 11, min: 0, merchant: 'EKEDC Electricity', category: 'utilities', amount: -24000 },
    { day: 10, hour: 16, min: 0, merchant: 'Lagos BRT', category: 'transport', amount: -600 },
    { day: 11, hour: 13, min: 0, merchant: 'KFC Ikeja', category: 'dining_food_delivery', amount: -5800 },
    { day: 12, hour: 14, min: 0, merchant: 'Spar Nigeria', category: 'groceries', amount: -16500 },
    { day: 13, hour: 15, min: 0, merchant: 'Silverbird Cinema', category: 'entertainment_leisure', amount: -7000 },
    { day: 15, hour: 13, min: 0, merchant: 'Chicken Republic', category: 'dining_food_delivery', amount: -4600 },
    { day: 16, hour: 17, min: 0, merchant: 'Uber Nigeria', category: 'transport', amount: -4000 },
    { day: 18, hour: 12, min: 0, merchant: 'Justrite Superstore', category: 'groceries', amount: -15000 },
    { day: 19, hour: 14, min: 0, merchant: 'TFC Restaurant', category: 'dining_food_delivery', amount: -11500 },
    { day: 20, hour: 10, min: 0, merchant: 'GTBank ATM', category: 'cash_withdrawal', amount: -25000 },
    { day: 22, hour: 12, min: 0, merchant: 'Cold Stone Creamery', category: 'dining_food_delivery', amount: -4200 },
    { day: 23, hour: 16, min: 0, merchant: 'The Zone Lagos', category: 'entertainment_leisure', amount: -5000 },
    { day: 25, hour: 9, min: 0, merchant: 'Pinnacle Technologies', category: 'salary_wages', amount: 0 }, // amount set per-month below
    { day: 26, hour: 14, min: 0, merchant: 'Justrite Superstore', category: 'groceries', amount: -12500 },
  ];

  // Index 5 = 5 months ago (oldest) … index 0 = current month. Dining and
  // subscriptions rise toward the present; salary rises with each pay cycle.
  const monthMultiplier = [0.72, 0.8, 0.88, 0.94, 1.0, 1.06]; // [5mo ago .. current]
  const salaryByMonthsAgo = (monthsAgo: number) => 355000 + (5 - monthsAgo) * 4200;

  const transactions: NewTransaction[] = [];

  for (let monthsAgo = 5; monthsAgo >= 0; monthsAgo--) {
    const mult = monthMultiplier[5 - monthsAgo];
    for (const line of monthlyTemplate) {
      const date = monthDate(monthsAgo, line.day, line.hour, line.min);
      if (!date) continue;

      const isSalary = line.category === 'salary_wages';
      const isRisingCategory = line.category === 'dining_food_delivery' || line.category === 'subscriptions';
      const amount = isSalary
        ? salaryByMonthsAgo(monthsAgo)
        : isRisingCategory
          ? Math.round(line.amount * mult)
          : line.amount;

      const bankId = KUDA_CATEGORIES.has(line.category) ? kudaBankId : accessBankId;
      const accountId = KUDA_CATEGORIES.has(line.category) ? kudaAccount.id : accessAccount.id;

      transactions.push({
        userId,
        bankId,
        accountId,
        emailConnectionId: null,
        parserTemplateId: null,
        gmailMessageId: null,
        merchant: line.merchant,
        category: line.category,
        transactionType: amount > 0 ? 'credit' : 'debit',
        amount,
        currency: 'NGN',
        refAmount: amount,
        refCurrency: 'NGN',
        exchangeRateUsed: null,
        transactionDate: date,
        status: 'verified',
        originalMerchant: line.merchant,
        originalCategory: line.category,
        reference: isSalary ? `SAL/${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}` : null,
        balance: null, // filled in per-account after sorting, below
      });
    }
  }

  // ── 4b. Multi-currency: a few standalone Wise (GBP) transactions ──────────
  transactions.push(
    {
      userId,
      bankId: wiseBankId,
      accountId: wiseAccount.id,
      emailConnectionId: null,
      parserTemplateId: null,
      gmailMessageId: null,
      merchant: 'Adobe Creative Cloud',
      category: 'subscriptions',
      transactionType: 'debit',
      amount: -13,
      currency: 'GBP',
      refAmount: -13 * 1900,
      refCurrency: 'NGN',
      exchangeRateUsed: 1900,
      transactionDate: daysAgo(38, 9, 0),
      status: 'verified',
      originalMerchant: 'Adobe Creative Cloud',
      originalCategory: 'subscriptions',
      reference: null,
      balance: null,
    },
    {
      userId,
      bankId: wiseBankId,
      accountId: wiseAccount.id,
      emailConnectionId: null,
      parserTemplateId: null,
      gmailMessageId: null,
      merchant: 'Freelance Client Payment',
      category: 'salary_wages',
      transactionType: 'credit',
      amount: 250,
      currency: 'GBP',
      refAmount: 250 * 1900,
      refCurrency: 'NGN',
      exchangeRateUsed: 1900,
      transactionDate: daysAgo(20, 10, 30),
      status: 'verified',
      originalMerchant: 'Freelance Client Payment',
      originalCategory: 'salary_wages',
      reference: 'FRL/GBP',
      balance: null,
    },
    {
      userId,
      bankId: wiseBankId,
      accountId: wiseAccount.id,
      emailConnectionId: null,
      parserTemplateId: null,
      gmailMessageId: null,
      merchant: 'Adobe Creative Cloud',
      category: 'subscriptions',
      transactionType: 'debit',
      amount: -13,
      currency: 'GBP',
      refAmount: -13 * 1900,
      refCurrency: 'NGN',
      exchangeRateUsed: 1900,
      transactionDate: daysAgo(8, 9, 0),
      status: 'verified',
      originalMerchant: 'Adobe Creative Cloud',
      originalCategory: 'subscriptions',
      reference: null,
      balance: null,
    },
  );

  // ── 4c. Needs-review transactions (unverified, straight from ingestion) ───
  transactions.push(
    {
      userId,
      bankId: accessBankId,
      accountId: accessAccount.id,
      emailConnectionId: null,
      parserTemplateId: null,
      gmailMessageId: null,
      merchant: 'AWOOF Superstore',
      category: 'uncategorized',
      transactionType: 'debit',
      amount: -12500,
      currency: 'NGN',
      refAmount: -12500,
      refCurrency: 'NGN',
      exchangeRateUsed: null,
      transactionDate: daysAgo(1, 16, 0),
      status: 'unverified',
      originalMerchant: 'AWOOF Superstore',
      originalCategory: 'uncategorized',
      reference: null,
      balance: null,
    },
    {
      userId,
      bankId: accessBankId,
      accountId: accessAccount.id,
      emailConnectionId: null,
      parserTemplateId: null,
      gmailMessageId: null,
      merchant: 'Bolt Food',
      category: 'uncategorized',
      transactionType: 'debit',
      amount: -8000,
      currency: 'NGN',
      refAmount: -8000,
      refCurrency: 'NGN',
      exchangeRateUsed: null,
      transactionDate: daysAgo(0, 9, 0),
      status: 'unverified',
      originalMerchant: 'Bolt Food',
      originalCategory: 'uncategorized',
      reference: null,
      balance: null,
    },
    // A regex match too low-confidence to auto-promote — flagged for the
    // parser-rule audit queue rather than a plain "unverified" first parse.
    {
      userId,
      bankId: accessBankId,
      accountId: accessAccount.id,
      emailConnectionId: null,
      parserTemplateId: null,
      gmailMessageId: null,
      merchant: 'Konga Marketplace',
      category: 'retail_ecommerce',
      transactionType: 'debit',
      amount: -9400,
      currency: 'NGN',
      refAmount: -9400,
      refCurrency: 'NGN',
      exchangeRateUsed: null,
      transactionDate: daysAgo(2, 11, 0),
      status: 'review',
      originalMerchant: 'Konga Marketplace',
      originalCategory: 'retail_ecommerce',
      reference: null,
      balance: null,
    },
  );

  // ── 4d. A user-corrected transaction (originally miscategorized) ──────────
  transactions.push({
    userId,
    bankId: accessBankId,
    accountId: accessAccount.id,
    emailConnectionId: null,
    parserTemplateId: null,
    gmailMessageId: null,
    merchant: 'Aroma Coffee House',
    category: 'groceries',
    transactionType: 'debit',
    amount: -6200,
    currency: 'NGN',
    refAmount: -6200,
    refCurrency: 'NGN',
    exchangeRateUsed: null,
    transactionDate: daysAgo(6, 13, 30),
    status: 'corrected',
    originalMerchant: 'Aroma Coffee House',
    originalCategory: 'dining_food_delivery',
    reference: null,
    balance: null,
  });

  // ── 4e. Self-transfer scenarios ────────────────────────────────────────────
  // A clean matched pair (Access → Kuda, same amount, same currency, within
  // the detection window) that TransferDetectionService.rescanForUser will
  // link and relabel automatically below — exercises the real transfer
  // pipeline instead of hand-faking its outcome.
  transactions.push(
    {
      userId,
      bankId: accessBankId,
      accountId: accessAccount.id,
      emailConnectionId: null,
      parserTemplateId: null,
      gmailMessageId: null,
      merchant: 'Alex Adeyemi - Kuda',
      category: 'peer_to_peer_transfer',
      transactionType: 'debit',
      amount: -50000,
      currency: 'NGN',
      refAmount: -50000,
      refCurrency: 'NGN',
      exchangeRateUsed: null,
      transactionDate: daysAgo(5, 10, 0),
      status: 'verified',
      originalMerchant: 'Alex Adeyemi - Kuda',
      originalCategory: 'peer_to_peer_transfer',
      reference: 'ACC/TRF/OWN/001',
      balance: null,
    },
    {
      userId,
      bankId: kudaBankId,
      accountId: kudaAccount.id,
      emailConnectionId: null,
      parserTemplateId: null,
      gmailMessageId: null,
      merchant: 'Alex Adeyemi - Access Bank',
      category: 'peer_to_peer_transfer',
      transactionType: 'credit',
      amount: 50000,
      currency: 'NGN',
      refAmount: 50000,
      refCurrency: 'NGN',
      exchangeRateUsed: null,
      transactionDate: daysAgo(5, 10, 12),
      status: 'verified',
      originalMerchant: 'Alex Adeyemi - Access Bank',
      originalCategory: 'peer_to_peer_transfer',
      reference: 'KUDA-CR-88213',
      balance: null,
    },
  );
  // An unmatched leg already tagged self_transfer by the parser, but whose
  // other leg's bank was never connected — no candidate exists, so the
  // rescan below excludes it on its own (auto_low confidence) and it
  // surfaces on the "review transfers" screen the same way a real one would.
  transactions.push({
    userId,
    bankId: accessBankId,
    accountId: accessAccount.id,
    emailConnectionId: null,
    parserTemplateId: null,
    gmailMessageId: null,
    merchant: 'GTBank Transfer - Own Account',
    category: 'self_transfer',
    transactionType: 'debit',
    amount: -15000,
    currency: 'NGN',
    refAmount: -15000,
    refCurrency: 'NGN',
    exchangeRateUsed: null,
    transactionDate: daysAgo(3, 15, 0),
    status: 'verified',
    originalMerchant: 'GTBank Transfer - Own Account',
    originalCategory: 'self_transfer',
    reference: 'TRF/OWN/002',
    balance: null,
  });
  // Same merchant, from a month back, but never picked up as a transfer —
  // demonstrates the "confirm one, apply to similar" bulk flow on Review
  // Transfers: confirming the instance above should offer to bulk-apply
  // self_transfer to this one too.
  transactions.push({
    userId,
    bankId: accessBankId,
    accountId: accessAccount.id,
    emailConnectionId: null,
    parserTemplateId: null,
    gmailMessageId: null,
    merchant: 'GTBank Transfer - Own Account',
    category: 'peer_to_peer_transfer',
    transactionType: 'debit',
    amount: -20000,
    currency: 'NGN',
    refAmount: -20000,
    refCurrency: 'NGN',
    exchangeRateUsed: null,
    transactionDate: daysAgo(33, 15, 0),
    status: 'verified',
    originalMerchant: 'GTBank Transfer - Own Account',
    originalCategory: 'peer_to_peer_transfer',
    reference: 'TRF/OWN/000',
    balance: null,
  });

  // ── 4f. Compute a running balance per account ─────────────────────────────
  // The accounts list shows each account's balance as the most recent
  // transaction's stored `balance` — realistic opening balances, walked
  // forward chronologically, so the newest row per account carries a
  // sensible running total instead of every account showing "—".
  const openingBalance: Record<number, number> = {
    [accessAccount.id]: 150000,
    [kudaAccount.id]: 20000,
    [wiseAccount.id]: 200,
  };
  const byAccount = new Map<number, NewTransaction[]>();
  for (const t of transactions) {
    const list = byAccount.get(t.accountId as number) ?? [];
    list.push(t);
    byAccount.set(t.accountId as number, list);
  }
  for (const [accountId, list] of byAccount) {
    list.sort((a, b) => (a.transactionDate as Date).getTime() - (b.transactionDate as Date).getTime());
    let running = openingBalance[accountId] ?? 0;
    for (const t of list) {
      running += t.amount as number;
      t.balance = Math.round(running * 100) / 100;
    }
  }

  const inserted = await db.client.insert(TransactionSchema).values(transactions).returning();
  console.log(`  ✓ Inserted ${inserted.length} transactions across 3 accounts`);

  // ── 5. Detect self-transfers for real, via the actual detection pipeline ──
  const transactionRepository = new TransactionRepositoryImpl(db);
  const transferLinkRepository = new TransferLinkRepositoryImpl(db);
  const accountTransferRuleRepository = new AccountTransferRuleRepositoryImpl(db);
  const exchangeRateService = new ExchangeRateService(new ExchangeRateRepositoryImpl(db));
  const notificationService = new NotificationService(new NotificationRepositoryImpl(db));
  const transferDetectionService = new TransferDetectionService(
    transactionRepository,
    transferLinkRepository,
    exchangeRateService,
    accountTransferRuleRepository,
    notificationService,
  );
  const { scanned, linked } = await transferDetectionService.rescanForUser(userId);
  console.log(`  ✓ Transfer detection rescan: ${scanned} scanned, ${linked} linked`);

  // ── 6. Budgets, calibrated against this month's actual spend ─────────────
  // So the demo shows OVER / WARNING / HEALTHY regardless of what day of the
  // month it's run on — limits are derived from real month-to-date spend
  // (refAmount, matching how BudgetService computes it) rather than fixed
  // figures that only looked right in the original hardcoded month.
  const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const currentMonthSpend = new Map<string, number>();
  for (const t of inserted as ITransaction[]) {
    if (t.amount >= 0) continue;
    if (t.transactionDate < startOfMonth || t.transactionDate > today) continue;
    if (t.category === 'self_transfer' || t.category === 'peer_to_peer_transfer' || t.category === 'currency_conversion') continue;
    currentMonthSpend.set(t.category, (currentMonthSpend.get(t.category) ?? 0) + Math.abs(t.refAmount));
  }
  const spendFor = (category: string, fallback: number) => currentMonthSpend.get(category) || fallback;

  const budgets: NewBudget[] = [
    {
      userId,
      category: 'dining_food_delivery',
      limitAmount: Math.round(spendFor('dining_food_delivery', 45000) / 1.15),
      currency: 'NGN',
      periodType: 'monthly',
      isActive: true,
      isSuggestedByAi: true,
      habitDescription:
        "You've been spending more on dining every month for a while now. Limit set just under this month's pace to help rein in a creeping trend.",
    },
    {
      userId,
      category: 'subscriptions',
      limitAmount: Math.round(spendFor('subscriptions', 17300) / 0.85),
      currency: 'NGN',
      periodType: 'monthly',
      isActive: true,
      isSuggestedByAi: true,
      habitDescription: 'Netflix, Spotify and DSTV add up every month. Limit set to flag any new subscription creeping in.',
    },
    {
      userId,
      category: 'groceries',
      limitAmount: Math.round(spendFor('groceries', 65000) / 0.63),
      currency: 'NGN',
      periodType: 'monthly',
      isActive: true,
      isSuggestedByAi: true,
      habitDescription: 'Grocery spending is fairly steady month to month. Limit set as a realistic ceiling that keeps you on track.',
    },
    {
      userId,
      category: 'transport',
      limitAmount: Math.round(spendFor('transport', 14400) / 0.52),
      currency: 'NGN',
      periodType: 'monthly',
      isActive: true,
      isSuggestedByAi: true,
      habitDescription: 'Mostly Uber and Bolt. Limit set to give breathing room without encouraging overspend.',
    },
    {
      userId,
      category: 'entertainment_leisure',
      limitAmount: Math.round(spendFor('entertainment_leisure', 12000) / 0.37),
      currency: 'NGN',
      periodType: 'monthly',
      isActive: true,
      isSuggestedByAi: true,
      habitDescription: 'Mostly cinema trips. Limit set to give freedom while keeping savings goals in sight.',
    },
    {
      userId,
      category: 'mobile_internet',
      limitAmount: Math.round(spendFor('mobile_internet', 4800) / 0.5),
      currency: 'NGN',
      periodType: 'monthly',
      isActive: true,
      isSuggestedByAi: true,
      habitDescription: 'Data and airtime run reliably every month. Limit set to cover any spike months.',
    },
  ];

  await db.client.insert(BudgetSchema).values(budgets);
  console.log(`  ✓ Inserted ${budgets.length} budgets`);

  // ── 7. Goals ────────────────────────────────────────────────────────────
  const goals: NewGoal[] = [
    {
      userId,
      name: 'Emergency Fund',
      type: GoalTypeEnum.SAVE,
      targetAmount: 500000,
      savedAmount: 212500,
      currency: 'NGN',
      targetDate: new Date(today.getFullYear(), today.getMonth() + 6, 1),
      isActive: true,
    },
    {
      userId,
      name: 'Pay Off Credit Card',
      type: GoalTypeEnum.DEBT,
      targetAmount: 150000,
      savedAmount: 45000,
      currency: 'NGN',
      targetDate: new Date(today.getFullYear(), today.getMonth() + 3, 1),
      isActive: true,
    },
    {
      userId,
      name: 'No-Spend Weekends',
      type: GoalTypeEnum.DAILY,
      targetAmount: null,
      savedAmount: 0,
      currency: 'NGN',
      targetDate: null,
      isActive: true,
    },
  ];
  await db.client.insert(GoalSchema).values(goals);
  console.log(`  ✓ Inserted ${goals.length} goals`);

  // ── 8. Insights ("Iris noticed...") ───────────────────────────────────────
  const diningBudget = budgets[0];
  const insights: NewInsight[] = [
    {
      userId,
      type: InsightTypeEnum.BUDGET_WARNING,
      message: `Your dining & food delivery spend is close to this month's ₦${diningBudget.limitAmount.toLocaleString()} limit. A few fewer delivery orders would keep you under.`,
      contextData: { category: 'dining_food_delivery' },
      isRead: false,
      expiresAt: new Date(today.getFullYear(), today.getMonth() + 1, 5),
      createdAt: daysAgo(1, 8, 0),
    },
    {
      userId,
      type: InsightTypeEnum.SPENDING_PATTERN,
      message: 'Dining & food delivery has crept up for three months running. Worth a look if that trend caught you off guard.',
      contextData: { category: 'dining_food_delivery', trend: 'rising', months: 3 },
      isRead: false,
      expiresAt: null,
      createdAt: daysAgo(3, 9, 0),
    },
    {
      userId,
      type: InsightTypeEnum.SUBSCRIPTION_ALERT,
      message: 'Netflix, Spotify and DSTV together now cost more than they did six months ago, worth a quick audit.',
      contextData: { category: 'subscriptions', services: ['Netflix', 'Spotify', 'DSTV Compact'] },
      isRead: true,
      expiresAt: null,
      createdAt: daysAgo(9, 10, 0),
    },
    {
      userId,
      type: InsightTypeEnum.POSITIVE_REINFORCEMENT,
      message: `Groceries have stayed comfortably under budget for the last two months, nice and steady.`,
      contextData: { category: 'groceries' },
      isRead: true,
      expiresAt: null,
      createdAt: daysAgo(12, 14, 0),
    },
    {
      userId,
      type: InsightTypeEnum.GOAL_PROGRESS,
      message: "You're 42% of the way to your Emergency Fund goal. Keep the current pace and you'll hit it on schedule.",
      contextData: { goal: 'Emergency Fund', progressPercent: 42 },
      isRead: false,
      expiresAt: null,
      createdAt: daysAgo(2, 17, 0),
    },
  ];
  await db.client.insert(InsightSchema).values(insights);
  console.log(`  ✓ Inserted ${insights.length} insights`);

  // ── 9. Notifications ───────────────────────────────────────────────────────
  const notifications: NewNotification[] = [
    {
      userId,
      type: 'sync_complete',
      title: '3 new transactions organised from your Gmail',
      body: 'Iris matched them against your regular merchants automatically.',
      data: JSON.stringify({ processedCount: 3 }),
      readAt: daysAgo(0, 9, 5),
      createdAt: daysAgo(0, 9, 0),
    },
    {
      userId,
      type: 'budget_warning',
      title: 'Heads up: Dining & Food Delivery budget getting close',
      body: "You're approaching your dining budget for this month. You're getting close.",
      data: JSON.stringify({ category: 'dining_food_delivery' }),
      readAt: null,
      createdAt: daysAgo(1, 8, 5),
    },
    {
      userId,
      type: 'insight_generated',
      title: 'Iris has new insights for you',
      body: 'Your weekly financial summary is ready. Tap to see what Iris found.',
      data: JSON.stringify({}),
      readAt: null,
      createdAt: daysAgo(2, 17, 5),
    },
    {
      userId,
      type: 'sync_complete',
      title: 'Sync complete, nothing new',
      body: 'No new bank emails found since your last sync.',
      data: JSON.stringify({ processedCount: 0 }),
      readAt: daysAgo(6, 9, 5),
      createdAt: daysAgo(7, 9, 0),
    },
  ];
  await db.client.insert(NotificationSchema).values(notifications);
  console.log(`  ✓ Inserted ${notifications.length} notifications`);

  console.log('');
  console.log('✅ Demo seed complete!');
  console.log(`   Email:    ${DEMO_EMAIL}`);
  console.log(`   Password: ${DEMO_PASSWORD}`);
  console.log('');

  await db.close();
}

seedDemo().catch((err) => {
  console.error(err);
  process.exit(1);
});
