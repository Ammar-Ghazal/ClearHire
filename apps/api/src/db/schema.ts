// Sign-in tables, the minimal Muse analysis store (one row per run: results and code-free input
// metadata; per-attempt spend records; atomic budgets; employer priority overrides) and the
// imported demo fixtures, which never reference users. Repository code is never stored.
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
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

export interface InputManifest {
  repos: { repo: string; commitSha: string | null; unavailable: string | null }[];
  resumeSha256: string | null;
  /** Repository rows: the file paths this request assessed as its own (citable) evidence. */
  paths?: string[];
  /** Repository rows: `limited` when history was capped, a lookup failed or an author is unresolved. */
  attribution?: 'complete' | 'limited';
  /** Overlay rows: one disputed skill, re-examined at `repos[0].commitSha`. */
  reassessment?: {
    skillId: string;
    outcome: 'level' | 'removed' | 'inconclusive';
    rationale: string;
    paths: string[];
    justificationSha256: string;
  };
}

export const skillAssessments = pgTable(
  'skill_assessments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // A 'repository' row is one counted request (or a no-evidence result) for one repository of a
    // candidate; 'candidate' rows combine them. Repository rows keep the candidate's subject key.
    kind: text('kind', { enum: ['candidate', 'job', 'repository'] }).notNull(),
    // Demo subjects are fixture keys, never rows in users, so there is no foreign key.
    subjectKind: text('subject_kind', { enum: ['demo', 'user'] }).notNull(),
    subjectKey: text('subject_key').notNull(),
    /** Code-free input key: equal keys mean the same inputs, not a reusable lock. */
    cacheKey: text('cache_key').notNull(),
    /** Repository rows: GitHub repository id and part (`batch:i/n:<digest>:req:<digest>`, ...). */
    repoId: bigint('repo_id', { mode: 'number' }),
    part: text('part'),
    model: text('model').notNull(),
    catalogueVersion: integer('catalogue_version').notNull(),
    status: text('status', {
      enum: ['pending', 'complete', 'partial', 'no_attributed_evidence', 'failed'],
    }).notNull(),
    errorCode: text('error_code'),
    result: jsonb('result'),
    /** Commits and availability of the repositories a candidate run graded; null for jobs. */
    inputManifest: jsonb('input_manifest').$type<InputManifest>(),
    verifierVersion: integer('verifier_version'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index('skill_assessments_cache_key_idx').on(t.cacheKey),
    // Single-flight: at most one running assessment per subject.
    uniqueIndex('skill_assessments_pending_key')
      .on(t.kind, t.subjectKind, t.subjectKey)
      .where(sql`${t.status} = 'pending'`),
    index('skill_assessments_subject_idx').on(t.kind, t.subjectKind, t.subjectKey, t.model),
    index('skill_assessments_repo_idx').on(t.subjectKind, t.subjectKey, t.repoId),
  ],
);

/** Progress of one repository's pinned commit: download batches and which are fully processed. */
export interface RepositoryProgress {
  commitSha: string;
  /** Digest of each batch's file paths, in batch order. */
  batches: string[];
  done: number[];
  /** Only request rows completed at or after this instant count (a fresh regrade resets it). */
  since: string;
}

/**
 * The repositories chosen for one subject (at most 10 active) and their grading progress. A removed
 * repository is deactivated, never deleted, so its saved results can be reused if it returns.
 */
export const repositorySelections = pgTable(
  'repository_selections',
  {
    subjectKind: text('subject_kind', { enum: ['demo', 'user'] }).notNull(),
    subjectKey: text('subject_key').notNull(),
    repoId: bigint('repo_id', { mode: 'number' }).notNull(),
    fullName: text('full_name').notNull(),
    position: integer('position').notNull(),
    source: text('source', { enum: ['demo_default', 'user'] }).notNull(),
    active: boolean('active').notNull().default(true),
    /** Last code push GitHub reported in a listing; a push after `assessedAt` flags a change. */
    pushedAt: timestamp('pushed_at', { withTimezone: true }),
    /** The commit whose processed requests the combined markers use, and since when. */
    assessedCommit: text('assessed_commit'),
    assessedAt: timestamp('assessed_at', { withTimezone: true }),
    assessedSince: timestamp('assessed_since', { withTimezone: true }),
    /** Set while this repository's markers come from an older combined result, validated once. */
    legacyAssessmentId: uuid('legacy_assessment_id'),
    progress: jsonb('progress').$type<RepositoryProgress>(),
    /** An explicit regrade not yet started: kept until fresh progress is saved, so it survives a wait. */
    freshRequestedAt: timestamp('fresh_requested_at', { withTimezone: true }),
    /** Last failure code; permanent ones wait for an explicit regrade or a selection change. */
    lastError: text('last_error'),
    githubFailures: integer('github_failures').notNull().default(0),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.subjectKind, t.subjectKey, t.repoId] })],
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
  runStatus: text('run_status', { enum: ['idle', 'queued', 'pending', 'failed'] })
    .notNull()
    .default('idle'),
  queuedAt: timestamp('queued_at', { withTimezone: true }),
  runError: text('run_error'),
  runHeartbeatAt: timestamp('run_heartbeat_at', { withTimezone: true }),
};

export const demoEmployers = pgTable('demo_employers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  url: text('url').notNull(),
  location: text('location'),
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
  textSource: text('text_source', {
    enum: ['full_description', 'source_summary', 'fixture_summary'],
  }).notNull(),
  /** When the posting content was retrieved, and what it cannot show. */
  retrievedOn: text('retrieved_on'),
  sourceLimitations: jsonb('source_limitations').$type<string[]>().notNull().default([]),
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
  // Lab and company accounts are never fetched or analysed as a person.
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
  /** When default repositories were chosen; set even when none qualified, so it runs once. */
  selectionCheckedAt: timestamp('selection_checked_at', { withTimezone: true }),
  /** Last metadata-only listing, which refreshes push times behind change warnings. */
  metadataRefreshedAt: timestamp('metadata_refreshed_at', { withTimezone: true }),
  ...runColumns,
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---- Demo recruiting workflow (acted on by a demo identity, never by a signed-in user) ----

const answer = (name: string) => text(name, { enum: ['yes', 'maybe', 'no'] });

/** One per candidate × posting; a missing row means neither side has answered. */
export const demoRelationships = pgTable(
  'demo_relationships',
  {
    candidateKey: text('candidate_key')
      .notNull()
      .references(() => demoCandidates.key, { onDelete: 'cascade' }),
    jobId: text('job_id')
      .notNull()
      .references(() => demoJobs.id, { onDelete: 'cascade' }),
    candidateAnswer: answer('candidate_answer'),
    employerAnswer: answer('employer_answer'),
    candidateConfirmedAt: timestamp('candidate_confirmed_at', { withTimezone: true }),
    employerConfirmedAt: timestamp('employer_confirmed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.candidateKey, t.jobId] })],
);

const relationshipRef = {
  candidateKey: text('candidate_key').notNull(),
  jobId: text('job_id').notNull(),
};
const relationshipFk = (t: { candidateKey: AnyPgColumn; jobId: AnyPgColumn }) =>
  foreignKey({
    columns: [t.candidateKey, t.jobId],
    foreignColumns: [demoRelationships.candidateKey, demoRelationships.jobId],
  }).onDelete('cascade');

export const demoMessages = pgTable(
  'demo_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...relationshipRef,
    authorSide: text('author_side', { enum: ['candidate', 'employer'] }).notNull(),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [relationshipFk(t), index('demo_messages_relationship_idx').on(t.candidateKey, t.jobId)],
);

export const demoInterviews = pgTable(
  'demo_interviews',
  {
    ...relationshipRef,
    format: text('format', { enum: ['video', 'phone', 'in_person'] }).notNull(),
    lengthMinutes: integer('length_minutes').notNull(),
    location: text('location').notNull(),
    confirmedSlotId: uuid('confirmed_slot_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.candidateKey, t.jobId] }), relationshipFk(t)],
);

export const demoInterviewSlots = pgTable(
  'demo_interview_slots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...relationshipRef,
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.candidateKey, t.jobId],
      foreignColumns: [demoInterviews.candidateKey, demoInterviews.jobId],
    }).onDelete('cascade'),
  ],
);

export const demoOffers = pgTable(
  'demo_offers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...relationshipRef,
    role: text('role').notNull(),
    baseSalaryCad: integer('base_salary_cad').notNull(),
    startDate: date('start_date').notNull(),
    arrangement: text('arrangement', { enum: ['on_site', 'hybrid', 'remote'] }).notNull(),
    note: text('note').notNull().default(''),
    status: text('status', { enum: ['draft', 'shared', 'accepted', 'declined', 'withdrawn'] })
      .notNull()
      .default('draft'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('demo_offers_relationship_key').on(t.candidateKey, t.jobId), relationshipFk(t)],
);

/** Seeker preferences: editable, never used in scoring. */
export const demoPreferences = pgTable('demo_preferences', {
  candidateKey: text('candidate_key')
    .primaryKey()
    .references(() => demoCandidates.key, { onDelete: 'cascade' }),
  titles: jsonb('titles').$type<string[]>().notNull(),
  locations: jsonb('locations').$type<string[]>().notNull(),
  arrangements: jsonb('arrangements').$type<('on_site' | 'hybrid' | 'remote')[]>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
