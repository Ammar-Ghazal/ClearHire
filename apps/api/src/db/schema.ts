// Skeleton schema: only what sign-in needs. Ingestion and analysis tables come later (R-4.3).
import { bigint, boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    githubUserId: bigint('github_user_id', { mode: 'number' }).notNull(),
    login: text('login').notNull(),
    name: text('name'),
    avatarUrl: text('avatar_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_github_user_id_key').on(t.githubUserId)],
);

export const userEmails = pgTable(
  'user_emails',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    verified: boolean('verified').notNull(),
    primary: boolean('primary').notNull().default(false),
  },
  (t) => [uniqueIndex('user_emails_user_email_key').on(t.userId, t.email)],
);

export const githubConnections = pgTable(
  'github_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    installationId: bigint('installation_id', { mode: 'number' }),
    // AES-256-GCM ciphertext (see lib/crypto.ts); never stored in plain text.
    accessTokenEnc: text('access_token_enc').notNull(),
    refreshTokenEnc: text('refresh_token_enc'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    status: text('status', { enum: ['active', 'revoked'] }).notNull().default('active'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('github_connections_user_id_key').on(t.userId)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
);
