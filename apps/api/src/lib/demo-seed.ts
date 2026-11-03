// The demo seed's field allowlist. Strict on load: a record with any other field (a prepared
// repository snapshot, evidence text, raw model output) rejects the whole seed.
import { z } from 'zod';

const date = z.coerce.date();
const nullableText = z.string().nullable();
/** Recorded fixture JSON (profiles, postings): always an object. */
const record = z.record(z.unknown());

const EmployerSeed = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    url: z.string(),
    location: nullableText,
    raw: record,
    recordSha256: z.string(),
  })
  .strict();

const JobSeed = z
  .object({
    id: z.string(),
    employerId: z.string(),
    title: z.string(),
    location: nullableText,
    sourceUrl: z.string(),
    sourceChecked: nullableText,
    scenario: z.string(),
    inScope: z.boolean(),
    text: z.string(),
    textSource: z.enum(['full_description', 'source_summary', 'fixture_summary']),
    retrievedOn: nullableText,
    sourceLimitations: z.array(z.string()),
    raw: record,
    recordSha256: z.string(),
    inputSha256: z.string(),
  })
  .strict();

const CandidateSeed = z
  .object({
    key: z.string(),
    name: z.string(),
    githubUrl: z.string(),
    githubLogin: z.string(),
    organization: z.boolean(),
    repositories: z.array(
      z.object({ owner: z.string(), repo: z.string(), pinnedSha: nullableText }).strict(),
    ),
    verification: record,
    raw: record,
    profileSha256: z.string(),
    resumeUrl: nullableText,
    resumeType: nullableText,
    resumeSource: record.nullable(),
    resumePdfSha256: nullableText,
    resumeStatus: z.enum(['none', 'extracted', 'needs_review']),
    resumeReviewReason: nullableText,
    resumePages: z.number().int().nullable(),
    resumeText: nullableText,
  })
  .strict();

const ManifestSeed = z
  .object({
    repos: z.array(
      z
        .object({ repo: z.string(), commitSha: nullableText, unavailable: nullableText })
        .strict(),
    ),
    resumeSha256: nullableText,
  })
  .strict();

const AssessmentSeed = z
  .object({
    kind: z.enum(['candidate', 'job']),
    subjectKind: z.enum(['demo', 'user']),
    subjectKey: z.string(),
    cacheKey: z.string(),
    model: z.string(),
    catalogueVersion: z.number().int(),
    status: z.enum(['complete', 'partial', 'no_attributed_evidence']),
    errorCode: nullableText,
    /** Checked against the shared assessment schema when loaded. */
    result: z.unknown(),
    inputManifest: ManifestSeed.nullable(),
    verifierVersion: z.number().int().nullable(),
    startedAt: date,
    heartbeatAt: date,
    completedAt: date.nullable(),
  })
  .strict();

/** A seeker's recorded analysis spend; loading never lowers it. */
const SpendSeed = z
  .object({
    scope: z.string().regex(/^subject:candidate:demo:[^:]+$/),
    spentMicroUsd: z.number().int().min(0),
  })
  .strict();

export const SeedSchema = z
  .object({
    employers: z.array(EmployerSeed),
    jobs: z.array(JobSeed),
    candidates: z.array(CandidateSeed),
    assessments: z.array(AssessmentSeed),
    spend: z.array(SpendSeed),
  })
  .strict();
export type Seed = z.infer<typeof SeedSchema>;
