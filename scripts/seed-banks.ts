import 'reflect-metadata';
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { BankSchema } from '../src/modules/bank/bank.schema';

const BANKS = [
  {
    name: 'GTBank',
    shortCode: 'gtbank',
    country: 'NG',
    knownSenderEmails: [
      'gens@gtbank.com',
      'noreply@gtbank.com',
      'no-reply@gtbank.com',
      'alerts@gtbank.com',
      'gtbank@gtbank.com',
    ],
  },
  {
    name: 'Access Bank',
    shortCode: 'access',
    country: 'NG',
    knownSenderEmails: [
      'no_reply@accessbankplc.com',
      'noreply@accessbankplc.com',
      'alerts@accessbankplc.com',
      'accessbank@accessbankplc.com',
    ],
  },
  {
    name: 'Stanbic IBTC',
    shortCode: 'stanbic',
    country: 'NG',
    knownSenderEmails: [
      'stanbicibtc-e-alert@stanbicibtc.com',
      'ibtcalerts@stanbicibtc.com',
      'noreply@stanbicibtc.com',
      'alerts@stanbicibtc.com',
    ],
  },
  {
    name: 'Zenith Bank',
    shortCode: 'zenith',
    country: 'NG',
    knownSenderEmails: [
      'alerts@zenithbank.com',
      'noreply@zenithbank.com',
      'no_reply@zenithbank.com',
      'zenithbank@zenithbank.com',
    ],
  },
  {
    name: 'First Bank',
    shortCode: 'firstbank',
    country: 'NG',
    knownSenderEmails: [
      'alerts@firstbanknigeria.com',
      'noreply@firstbanknigeria.com',
      'no_reply@firstbanknigeria.com',
    ],
  },
  {
    name: 'UBA',
    shortCode: 'uba',
    country: 'NG',
    knownSenderEmails: [
      'alerts@ubagroup.com',
      'noreply@ubagroup.com',
      'no_reply@ubagroup.com',
      'uba@ubagroup.com',
    ],
  },
  {
    name: 'Kuda Bank',
    shortCode: 'kuda',
    country: 'NG',
    knownSenderEmails: [
      'noreply@kuda.com',
      'hello@kuda.com',
      'no_reply@kuda.com',
      'alerts@kuda.com',
    ],
  },
  {
    name: 'Opay',
    shortCode: 'opay',
    country: 'NG',
    knownSenderEmails: [
      'noreply@opay.com',
      'no_reply@opay.com',
      'alerts@opay.com',
      'notification@opay.com',
    ],
  },
  {
    name: 'Moniepoint',
    shortCode: 'moniepoint',
    country: 'NG',
    knownSenderEmails: [
      'noreply@moniepoint.com',
      'alerts@moniepoint.com',
      'no_reply@moniepoint.com',
    ],
  },
  {
    name: 'Sterling Bank',
    shortCode: 'sterling',
    country: 'NG',
    knownSenderEmails: [
      'alerts@sterling.ng',
      'noreply@sterling.ng',
      'no_reply@sterling.ng',
    ],
  },
  {
    name: 'Ecobank',
    shortCode: 'ecobank',
    country: 'NG',
    knownSenderEmails: [
      'ecobank@ecobank.com',
      'noreply@ecobank.com',
      'alerts@ecobank.com',
    ],
  },
  {
    name: 'Fidelity Bank',
    shortCode: 'fidelity',
    country: 'NG',
    knownSenderEmails: [
      'alerts@fidelitybank.ng',
      'noreply@fidelitybank.ng',
      'no_reply@fidelitybank.ng',
    ],
  },
  {
    name: 'FCMB',
    shortCode: 'fcmb',
    country: 'NG',
    knownSenderEmails: [
      'alerts@fcmb.com',
      'noreply@fcmb.com',
      'no_reply@fcmb.com',
    ],
  },
  {
    name: 'Wise',
    shortCode: 'wise',
    country: 'GB',
    knownSenderEmails: [
      'notification@wise.com',
      'noreply@wise.com',
      'no-reply@wise.com',
    ],
  },
  {
    name: 'Monzo',
    shortCode: 'monzo',
    country: 'GB',
    knownSenderEmails: [
      'noreply@monzo.com',
      'no-reply@monzo.com',
      'alerts@monzo.com',
    ],
  },
];

async function seed() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);

  for (const bank of BANKS) {
    await db
      .insert(BankSchema)
      .values(bank)
      .onConflictDoUpdate({
        target: BankSchema.shortCode,
        set: {
          knownSenderEmails: bank.knownSenderEmails,
          country: bank.country,
        },
      });
  }

  console.log(`Seeded/updated ${BANKS.length} banks`);
  await pool.end();
}

seed().catch(console.error);
