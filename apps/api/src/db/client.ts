import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../env.js';
import * as schema from './schema.js';

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5_000,
});

export const db = drizzle(pool, { schema });

/** True when Postgres answers a trivial query within the timeout. */
export async function databaseIsUp(): Promise<boolean> {
  try {
    await pool.query('select 1');
    return true;
  } catch {
    return false;
  }
}
