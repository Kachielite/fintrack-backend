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
    knownSenderDomains: ['gtbank.com'],
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
    knownSenderDomains: ['accessbankplc.com'],
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
    knownSenderDomains: ['stanbicibtc.com'],
  },
  {
    name: 'Zenith Bank',
    shortCode: 'zenith',
    country: 'NG',
    knownSenderEmails: [
      'alerts@zenithbank.com',
      'noreply@zenithbank.com',
      'no_reply@zenithbank.com',
      'ebusinessgroup@zenithbank.com',
      'zenithbank@zenithbank.com',
    ],
    knownSenderDomains: ['zenithbank.com'],
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
    knownSenderDomains: ['firstbanknigeria.com'],
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
    knownSenderDomains: ['ubagroup.com'],
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
    knownSenderDomains: ['kuda.com'],
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
    knownSenderDomains: ['opay.com'],
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
    knownSenderDomains: ['moniepoint.com'],
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
    knownSenderDomains: ['sterling.ng'],
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
    knownSenderDomains: ['ecobank.com'],
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
    knownSenderDomains: ['fidelitybank.ng'],
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
    knownSenderDomains: ['fcmb.com'],
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
    knownSenderDomains: ['wise.com'],
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
    knownSenderDomains: ['monzo.com'],
  },
  {
    name: 'M-Pesa',
    shortCode: 'mpesa',
    country: 'KE',
    knownSenderEmails: [
      'no-reply@safaricom.co.ke',
      'noreply@safaricom.co.ke',
      'mpesa@safaricom.co.ke',
    ],
    knownSenderDomains: ['safaricom.co.ke'],
  },
  {
    name: 'Airtel Money',
    shortCode: 'airtel-money',
    country: 'KE',
    knownSenderEmails: ['noreply@airtel.africa', 'no-reply@airtel.africa'],
    knownSenderDomains: ['airtel.africa'],
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
          knownSenderDomains: bank.knownSenderDomains,
          country: bank.country,
        },
      });
  }

  console.log(`Seeded/updated ${BANKS.length} banks`);
  await pool.end();
}

seed().catch(console.error);
