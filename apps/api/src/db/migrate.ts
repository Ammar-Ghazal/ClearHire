// Applies migrations from apps/api/drizzle. Run before the API starts (R-11.3).
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { db, pool } from './client.js';

// This file runs from src/db (tsx) or dist/db (built); both sit two levels below apps/api.
const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

try {
  await migrate(db, { migrationsFolder });
  console.log('Migrations applied.');
} catch (err) {
  console.error('Migration failed:', err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
