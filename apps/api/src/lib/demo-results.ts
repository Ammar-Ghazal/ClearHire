// Read side of the demo: freshness and matches. Uses only stored metadata and the shared code-free
// input key, so reads never call GitHub or Muse and never show an old result as current.
import {
  CandidateAssessmentSchema,
  JobAssessmentSchema,
  SKILL_CATALOGUE,
  type CandidateAssessment,
  type DemoMatch,
  type Freshness,
  type JobAssessment,
} from '@clearhire/shared';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  demoCandidates,
  demoJobs,
  jobPriorityOverrides,
  type InputManifest,
} from '../db/schema.js';
import { env } from '../env.js';
import {
  activeSelection,
  assessmentByFingerprint,
  combinedKey,
  jobFingerprint,
  latestSaved,
  type Lookup,
  type RunOptions,
} from './assessments.js';
import type { MuseModel } from './muse.js';
import type { DemoCandidateInput } from './demo-prepare.js';
import { matchAssessments } from './matching.js';

export type CandidateRow = typeof demoCandidates.$inferSelect;
export type JobRow = typeof demoJobs.$inferSelect;

export const candidateInput = (row: CandidateRow): DemoCandidateInput => ({
  key: row.key,
  githubLogin: row.githubLogin,
  repositories: row.repositories,
  resumeText: row.resumeStatus === 'extracted' ? row.resumeText : null,
});

const ROLE =
  /\b(engineer|developer|scientist|researcher|architect|director|manager|lead|student|analyst|consultant|designer)\b/i;

/**
 * The résumé's own headline: the text after the name on the first line, or the line under it, kept
 * only when it reads as a bare job title. A '|' headline keeps its first part. Anything else
 * (contact details, dates, prose) is ambiguous and gives null.
 * shortcut: a positional heuristic over extracted text; store a reviewed title if imports grow.
 */
export function resumeTitle(name: string, resumeText: string | null): string | null {
  const [first = '', second = ''] = resumeText?.split('\n') ?? [];
  const named = first.toLowerCase().startsWith(`${name.toLowerCase()} `);
  for (const line of [named ? first.slice(name.length) : '', second]) {
    const head = line.split('|')[0]!.trim();
    if (head && head.length <= 60 && !/[@:/\d]/.test(head) && ROLE.test(head)) return head;
  }
  return null;
}

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

export interface CandidateState {
  freshness: Freshness;
  assessment: CandidateAssessment | null;
  /** Commits and availability behind the current assessment; null when none is current. */
  manifest: InputManifest | null;
  /** The active repository selection, in order; empty before defaults are chosen. */
  selection: Awaited<ReturnType<typeof activeSelection>>;
}

/** Organization accounts are never graded; individuals get default repositories from GitHub. */
export const gradable = (row: Pick<CandidateRow, 'organization'>) => !row.organization;

/**
 * Prefer the combined markers for the active selection. Older markers can still score
 * matches while their freshness state distinguishes them from a current assessment.
 */
export async function candidateState(
  row: CandidateRow,
  options: RunOptions = {},
): Promise<CandidateState> {
  const none = { assessment: null, manifest: null, selection: [] };
  if (!gradable(row)) return { freshness: freshness('not_applicable'), ...none };
  if (!modelConfigured(options)) return { freshness: freshness('model_not_configured'), ...none };
  const subject = { kind: 'demo' as const, key: row.key };
  const selection = await activeSelection(subject);
  if (selection.length === 0) {
    return { freshness: freshness(row.selectionCheckedAt ? 'not_applicable' : 'not_started'), ...none };
  }
  const model = (options.model ?? env.META_MODEL) as MuseModel;
  const cacheKey = combinedKey(
    subject,
    model,
    selection.map((s) => s.repoId),
  );
  const lookup = await assessmentByFingerprint('candidate', subject, cacheKey);
  const saved = lookup.state === 'current'
    ? null
    : await latestSaved('candidate', subject, model, SKILL_CATALOGUE.version);
  return {
    freshness: fromLookup(lookup),
    assessment: lookup.state === 'current'
      ? lookup.assessment
      : saved ? CandidateAssessmentSchema.parse(saved.result) : null,
    manifest: lookup.state === 'current' ? lookup.inputManifest : null,
    selection,
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
  const subject = { kind: 'demo' as const, key: row.id };
  const { cacheKey, model } = jobFingerprint(jobInput(row), options);
  const lookup = await assessmentByFingerprint('job', subject, cacheKey);
  const saved = lookup.state === 'current'
    ? null
    : await latestSaved('job', subject, model, SKILL_CATALOGUE.version);
  return {
    freshness: fromLookup(lookup),
    assessment: lookup.state === 'current'
      ? lookup.assessment
      : saved ? JobAssessmentSchema.parse(saved.result) : null,
  };
}

export async function priorityOverrides(jobKey: string): Promise<Map<string, number>> {
  const rows = await db
    .select()
    .from(jobPriorityOverrides)
    .where(eq(jobPriorityOverrides.jobKey, jobKey));
  return new Map(rows.map((o) => [o.skillId, o.priority]));
}

/** Scores the current assessments or the last saved compatible results. */
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
