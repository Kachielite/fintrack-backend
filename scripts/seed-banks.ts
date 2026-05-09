import 'reflect-metadata';
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { BankSchema } from '../src/modules/bank/bank.schema';

const BANKS = [
  { name: 'GTBank', shortCode: 'gtbank', knownSenderEmails: ['noreply@gtbank.com', 'alerts@gtbank.com'] },
  { name: 'Kuda Bank', shortCode: 'kuda', knownSenderEmails: ['noreply@kuda.com', 'hello@kuda.com'] },
  { name: 'Wise', shortCode: 'wise', knownSenderEmails: ['notification@wise.com'] },
  { name: 'Access Bank', shortCode: 'access', knownSenderEmails: ['alerts@accessbankplc.com'] },
  { name: 'Zenith Bank', shortCode: 'zenith', knownSenderEmails: ['alerts@zenithbank.com'] },
  { name: 'Monzo', shortCode: 'monzo', knownSenderEmails: ['noreply@monzo.com'] },
  { name: 'Stanbic IBTC', shortCode: 'stanbic', knownSenderEmails: ['ibtcalerts@stanbicibtc.com'] },
  { name: 'Sterling Bank', shortCode: 'sterling', knownSenderEmails: ['alerts@sterling.ng'] },
  { name: 'Ecobank', shortCode: 'ecobank', knownSenderEmails: ['ecobank@ecobank.com'] },
];

async function seed() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);

  for (const bank of BANKS) {
    await db
      .insert(BankSchema)
      .values(bank)
      .onConflictDoNothing();
  }

  console.log(`Seeded ${BANKS.length} banks`);
  await pool.end();
}

seed().catch(console.error);
