// Sign-in tables, the minimal Muse analysis store (assessments: cache, results and single-flight
// lock in one row; per-attempt spend records; atomic budgets; employer priority overrides) and the
// imported demo fixtures, which never reference users.
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

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

export const skillAssessments = pgTable(
  'skill_assessments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind', { enum: ['candidate', 'job'] }).notNull(),
    // Demo subjects are fixture keys, never rows in users, so there is no foreign key.
    subjectKind: text('subject_kind', { enum: ['demo', 'user'] }).notNull(),
    subjectKey: text('subject_key').notNull(),
    cacheKey: text('cache_key').notNull(),
    model: text('model').notNull(),
    catalogueVersion: integer('catalogue_version').notNull(),
    status: text('status', {
      enum: ['pending', 'complete', 'partial', 'no_attributed_evidence', 'failed'],
    }).notNull(),
    errorCode: text('error_code'),
    rawOutput: jsonb('raw_output'),
    // Redacted evidence text with locations, hashes and attribution: results stay inspectable and
    // re-verifiable without fetching a repository that may have changed.
    evidence: jsonb('evidence'),
    result: jsonb('result'),
    verifierVersion: integer('verifier_version'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('skill_assessments_cache_key_key').on(t.cacheKey),
    index('skill_assessments_subject_idx').on(t.kind, t.subjectKind, t.subjectKey, t.model),
  ],
);

export const museCalls = pgTable(
  'muse_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assessmentId: uuid('assessment_id')
      .notNull()
      .references(() => skillAssessments.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),
    attempt: integer('attempt').notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    // 'ambiguous' means the charge is uncertain: the reservation became estimated spend.
    settlement: text('settlement', { enum: ['reserved', 'settled', 'released', 'ambiguous'] }).notNull(),
    costSource: text('cost_source', { enum: ['usage', 'reservation', 'none'] }),
    reservedMicroUsd: bigint('reserved_micro_usd', { mode: 'number' }).notNull(),
    costMicroUsd: bigint('cost_micro_usd', { mode: 'number' }),
    httpStatus: integer('http_status'),
    finishReason: text('finish_reason'),
    promptTokens: integer('prompt_tokens'),
    cachedTokens: integer('cached_tokens'),
    completionTokens: integer('completion_tokens'),
    reasoningTokens: integer('reasoning_tokens'),
    latencyMs: integer('latency_ms'),
    responseId: text('response_id'),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => [index('muse_calls_assessment_id_idx').on(t.assessmentId)],
);

export const museSpendBudgets = pgTable(
  'muse_spend_budgets',
  {
    scope: text('scope').primaryKey(),
    capMicroUsd: bigint('cap_micro_usd', { mode: 'number' }).notNull(),
    reservedMicroUsd: bigint('reserved_micro_usd', { mode: 'number' }).notNull().default(0),
    spentMicroUsd: bigint('spent_micro_usd', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('muse_spend_budgets_nonnegative', sql`${t.reservedMicroUsd} >= 0`)],
);

export const jobPriorityOverrides = pgTable(
  'job_priority_overrides',
  {
    jobKey: text('job_key').notNull(),
    skillId: text('skill_id').notNull(),
    priority: integer('priority').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.jobKey, t.skillId] }),
    check('job_priority_overrides_priority_range', sql`${t.priority} between 0 and 3`),
  ],
);

// ---- Demo fixtures (imported by scripts/import-demo.ts) ----

/** One run per subject: `run_id` is the ownership token every worker write is conditional on. */
const runColumns = {
  runId: uuid('run_id'),
  runStatus: text('run_status', { enum: ['idle', 'pending', 'failed'] }).notNull().default('idle'),
  runError: text('run_error'),
  runHeartbeatAt: timestamp('run_heartbeat_at', { withTimezone: true }),
};

export const demoEmployers = pgTable('demo_employers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  url: text('url').notNull(),
  raw: jsonb('raw').notNull(),
  recordSha256: text('record_sha256').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const demoJobs = pgTable('demo_jobs', {
  id: text('id').primaryKey(),
  employerId: text('employer_id')
    .notNull()
    .references(() => demoEmployers.id),
  title: text('title').notNull(),
  location: text('location'),
  sourceUrl: text('source_url').notNull(),
  sourceChecked: text('source_checked'),
  scenario: text('scenario').notNull(),
  inScope: boolean('in_scope').notNull(),
  text: text('text').notNull(),
  textSource: text('text_source', { enum: ['full_description', 'fixture_summary'] }).notNull(),
  raw: jsonb('raw').notNull(),
  recordSha256: text('record_sha256').notNull(),
  // Employer, title, text and text source: a change invalidates analyses and priority overrides.
  inputSha256: text('input_sha256').notNull(),
  ...runColumns,
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const demoCandidates = pgTable('demo_candidates', {
  key: text('key').primaryKey(),
  name: text('name').notNull(),
  githubUrl: text('github_url').notNull(),
  githubLogin: text('github_login').notNull(),
  // Lab and company accounts are never prepared or analysed as a person.
  organization: boolean('organization').notNull().default(false),
  repositories: jsonb('repositories')
    .$type<{ owner: string; repo: string; pinnedSha: string | null }[]>()
    .notNull(),
  verification: jsonb('verification').notNull(),
  raw: jsonb('raw').notNull(),
  profileSha256: text('profile_sha256').notNull(),
  resumeUrl: text('resume_url'),
  resumeType: text('resume_type'),
  // Manifest provenance for the local PDF; null when the profile has no resume.
  resumeSource: jsonb('resume_source'),
  resumePdfSha256: text('resume_pdf_sha256'),
  resumeStatus: text('resume_status', { enum: ['none', 'extracted', 'needs_review'] })
    .notNull()
    .default('none'),
  resumeReviewReason: text('resume_review_reason'),
  resumePages: integer('resume_pages'),
  // Never sent to clients; only flagged-free extractions are stored.
  resumeText: text('resume_text'),
  // serializePreparedCandidate output (GitHub snapshot and contributions), never sent to clients.
  prepared: jsonb('prepared'),
  preparedSha256: text('prepared_sha256'),
  ...runColumns,
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
