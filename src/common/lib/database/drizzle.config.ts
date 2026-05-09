import { defineConfig } from 'drizzle-kit';
import { CONSTANTS } from '@/common/configuration/constants';

export default defineConfig({
  schema: './src/modules/**/*.schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: CONSTANTS.DATABASE_URL,
  },
});
