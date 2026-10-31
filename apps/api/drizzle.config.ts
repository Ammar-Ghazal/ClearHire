import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';
import { fileURLToPath } from 'node:url';

config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  strict: true,
});
