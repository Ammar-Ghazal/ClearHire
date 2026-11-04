// Loads and validates configuration once. The server refuses to start on bad config.
import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { MUSE_MODELS, type MuseModel } from './lib/muse.js';

// In development, read the repo-root .env (found by walking up from this file).
// In production there is no .env; the host injects env vars.
function findEnvFile(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return undefined;
}
const envFile = findEnvFile();
if (envFile) config({ path: envFile, quiet: true });

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  WEB_ORIGIN: z.string().url(),
  API_PUBLIC_URL: z.string().url(),
  DATABASE_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET is missing or short: run `pnpm gen:keys`'),
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, {
      message: 'TOKEN_ENCRYPTION_KEY must be 32 bytes, base64: run `pnpm gen:keys`',
    }),
  GITHUB_APP_ID: optional,
  GITHUB_APP_SLUG: optional,
  GITHUB_CLIENT_ID: optional,
  GITHUB_CLIENT_SECRET: optional,
  META_API_KEY: optional,
  // Chosen explicitly: Contributor for approved public test data, Standard for the final demo.
  META_MODEL: optional.refine((v) => v === undefined || (MUSE_MODELS as string[]).includes(v), {
    message: `META_MODEL must be one of: ${MUSE_MODELS.join(', ')}`,
  }),
  META_BASE_URL: z.string().url().default('https://api.meta.ai/v1'),
  META_DAILY_CAP_USD: z.coerce.number().positive().default(5),
  META_SUBJECT_CAP_USD: z.coerce.number().positive().default(1),
  // Comma-separated GitHub logins allowed to start demo analyses and change priorities.
  DEMO_OPERATOR_LOGINS: optional,
}).refine((e) => !e.META_API_KEY || e.META_MODEL, {
  message: 'META_MODEL must be set explicitly when META_API_KEY is set',
  path: ['META_MODEL'],
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
  console.error(`Invalid configuration in .env:\n${lines.join('\n')}`);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  META_MODEL: parsed.data.META_MODEL as MuseModel | undefined,
  WEB_ORIGIN: parsed.data.WEB_ORIGIN.replace(/\/$/, ''),
  API_PUBLIC_URL: parsed.data.API_PUBLIC_URL.replace(/\/$/, ''),
};

export const isProduction = env.NODE_ENV === 'production';

/** Device sign-in needs the public client ID. */
export const githubConfigured = Boolean(env.GITHUB_CLIENT_ID);

/** Muse calls need a key and an explicitly chosen model; nothing switches models automatically. */
export const museConfigured = Boolean(env.META_API_KEY && env.META_MODEL);

const demoOperators = new Set(
  (env.DEMO_OPERATOR_LOGINS ?? '')
    .split(',')
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean),
);

/** Unset or empty allowlist: nobody may start paid demo work. */
export const isDemoOperator = (login: string) => demoOperators.has(login.toLowerCase());
