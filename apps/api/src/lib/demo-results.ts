// Read side of the demo: current inputs, freshness and matches. Uses only stored data and the
// shared fingerprint, so reads never call GitHub or Muse and never show an old result as current.
import {
  SKILL_CATALOGUE,
  type CandidateAssessment,
  type DemoMatch,
  type Freshness,
  type JobAssessment,
} from '@clearhire/shared';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { demoCandidates, demoJobs, jobPriorityOverrides } from '../db/schema.js';
import { env } from '../env.js';
import {
  assessmentByFingerprint,
  candidateFingerprint,
  jobFingerprint,
  type Lookup,
  type RunOptions,
} from './assessments.js';
import { parsePreparedCandidate } from './candidate-evidence.js';
import { effectiveInput, type DemoCandidateInput, type EffectiveInput } from './demo-prepare.js';
import { matchAssessments } from './matching.js';
import { MuseError } from './muse.js';

export type CandidateRow = typeof demoCandidates.$inferSelect;
export type JobRow = typeof demoJobs.$inferSelect;

export const candidateInput = (row: CandidateRow): DemoCandidateInput => ({
  key: row.key,
  githubLogin: row.githubLogin,
  repositories: row.repositories,
  resumeText: row.resumeStatus === 'extracted' ? row.resumeText : null,
});

export const storedPrepared = (row: CandidateRow) =>
  row.prepared === null ? null : parsePreparedCandidate(row.prepared);

export const jobInput = (row: JobRow) => ({
  jobKey: row.id,
  employerId: row.employerId,
  title: row.title,
  text: row.text,
  textSource: row.textSource,
});

const freshness = (
  state: Freshness['state'],
  extra: Partial<Omit<Freshness, 'state'>> = {},
): Freshness => ({ state, assessmentStatus: null, errorCode: null, completedAt: null, ...extra });

function fromLookup(lookup: Lookup<CandidateAssessment | JobAssessment>): Freshness {
  switch (lookup.state) {
    case 'current':
      return freshness('current', {
        assessmentStatus:
          lookup.assessment.kind === 'candidate' ? lookup.assessment.status : 'complete',
        completedAt: lookup.completedAt?.toISOString() ?? null,
      });
    case 'failed':
      return freshness('failed', { errorCode: lookup.errorCode });
    default:
      return freshness(lookup.state);
  }
}

const modelConfigured = (options: RunOptions) => Boolean(options.model ?? env.META_MODEL);
const codeOf = (err: unknown) => (err instanceof MuseError ? err.code : 'invalid_prepared_data');

export interface CandidateState {
  input: EffectiveInput | null;
  freshness: Freshness;
  assessment: CandidateAssessment | null;
}

export async function candidateState(
  row: CandidateRow,
  options: RunOptions = {},
): Promise<CandidateState> {
  if (row.organization || row.repositories.length === 0) {
    return { input: null, freshness: freshness('not_applicable'), assessment: null };
  }
  let input: EffectiveInput;
  try {
    input = effectiveInput(candidateInput(row), storedPrepared(row));
  } catch {
    return { input: null, freshness: freshness('input_error'), assessment: null };
  }
  if (input.kind !== 'ready')
    return { input, freshness: freshness('not_prepared'), assessment: null };
  if (!modelConfigured(options)) {
    return { input, freshness: freshness('model_not_configured'), assessment: null };
  }
  let cacheKey: string;
  try {
    cacheKey = candidateFingerprint(input.prepared, options).cacheKey;
  } catch (err) {
    return {
      input,
      freshness: freshness('input_error', { errorCode: codeOf(err) }),
      assessment: null,
    };
  }
  const lookup = await assessmentByFingerprint('candidate', input.prepared.subject, cacheKey);
  return {
    input,
    freshness: fromLookup(lookup),
    assessment: lookup.state === 'current' ? lookup.assessment : null,
  };
}

export interface JobState {
  freshness: Freshness;
  assessment: JobAssessment | null;
}

export async function jobState(row: JobRow, options: RunOptions = {}): Promise<JobState> {
  if (!row.inScope) return { freshness: freshness('not_applicable'), assessment: null };
  if (!modelConfigured(options)) {
    return { freshness: freshness('model_not_configured'), assessment: null };
  }
  const { cacheKey } = jobFingerprint(jobInput(row), options);
  const lookup = await assessmentByFingerprint('job', { kind: 'demo', key: row.id }, cacheKey);
  return {
    freshness: fromLookup(lookup),
    assessment: lookup.state === 'current' ? lookup.assessment : null,
  };
}

export async function priorityOverrides(jobKey: string): Promise<Map<string, number>> {
  const rows = await db
    .select()
    .from(jobPriorityOverrides)
    .where(eq(jobPriorityOverrides.jobKey, jobKey));
  return new Map(rows.map((o) => [o.skillId, o.priority]));
}

/** Scores only current assessments; anything else is unavailable, never a 0% score. */
export async function demoMatch(
  candidate: CandidateRow,
  job: JobRow,
  options: RunOptions = {},
): Promise<DemoMatch> {
  if (!job.inScope) {
    return {
      availability: 'available',
      match: {
        subject: { kind: 'demo', key: candidate.key },
        jobKey: job.id,
        catalogue: { id: SKILL_CATALOGUE.id, version: SKILL_CATALOGUE.version },
        status: 'unscored',
        reason: 'out_of_scope',
        requirements: [],
        eligibilityConstraints: [],
      },
    };
  }
  return matchFromStates(
    await candidateState(candidate, options),
    await jobState(job, options),
    await priorityOverrides(job.id),
  );
}

/** For callers that score many pairs: states and overrides are loaded once per subject. */
export function matchFromStates(
  c: CandidateState,
  j: JobState,
  overrides: ReadonlyMap<string, number>,
): DemoMatch {
  if (!c.assessment) return { availability: 'unavailable', reason: 'candidate_not_current' };
  if (c.assessment.status === 'no_attributed_evidence') {
    return { availability: 'unavailable', reason: 'no_attributed_evidence' };
  }
  if (!j.assessment) return { availability: 'unavailable', reason: 'job_not_current' };
  return {
    availability: 'available',
    match: matchAssessments(c.assessment, j.assessment, overrides),
  };
}
