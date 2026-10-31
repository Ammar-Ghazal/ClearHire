// Loads and validates configuration once. The server refuses to start on bad config.
import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

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
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
  console.error(`Invalid configuration in .env:\n${lines.join('\n')}`);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  WEB_ORIGIN: parsed.data.WEB_ORIGIN.replace(/\/$/, ''),
  API_PUBLIC_URL: parsed.data.API_PUBLIC_URL.replace(/\/$/, ''),
};

export const isProduction = env.NODE_ENV === 'production';

/** GitHub sign-in needs the client id and secret; everything else can come later. */
export const githubConfigured = Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
