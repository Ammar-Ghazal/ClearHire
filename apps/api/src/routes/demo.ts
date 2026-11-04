// Demo screen routes. Reads return stored results through explicit public fields and never call
// GitHub or Muse. Signed-in judges may regrade sample profiles. Operator and employer
// permissions still apply to posting analysis and priorities.
import {
  CandidateAssessmentSchema,
  PrioritySchema,
  ReassessmentBodySchema,
  RerunBodySchema,
  SKILL_CATALOGUE,
  SkillIdSchema,
  type RepositoryFlag,
  type AnalysisStart,
  type DemoCandidate,
  type DemoCandidateSummary,
  type DemoJob,
  type DemoJobSummary,
} from '@clearhire/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  demoCandidates,
  demoEmployers,
  demoJobs,
  jobPriorityOverrides,
  repositorySelections,
} from '../db/schema.js';
import { env, isDemoOperator } from '../env.js';
import {
  activeSelection,
  clearPriorityOverride,
  latestSaved,
  repositoryProvenance,
  setPriorityOverride,
} from '../lib/assessments.js';
import { signedInGitHub } from './me.js';
import { currentDemoIdentity } from '../lib/demo-identity.js';
import type { ResumeSource } from '../lib/demo-import.js';
import { TRANSIENT } from '../lib/demo-prepare.js';
import { formatPosting } from '../lib/posting-format.js';
import {
  candidateState,
  demoMatch,
  jobState,
  priorityOverrides,
  type CandidateRow,
  type JobRow,
} from '../lib/demo-results.js';
import {
  loggedDeps,
  startCandidateRun,
  startJobRun,
  startReassessment,
  type Started,
} from '../lib/demo-runner.js';
import { sha256Hex } from '../lib/packets.js';
import { buildRepositoryBreakdown } from '../lib/repository-breakdown.js';
import { currentUserLogin } from '../lib/sessions.js';

const SKILL_NAMES = new Map<string, string>(SKILL_CATALOGUE.skills.map((s) => [s.id, s.name]));

const send = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).send({ error: { code, message } });

async function requireOperator(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const login = await currentUserLogin(request);
  if (!login) {
    send(reply, 401, 'unauthenticated', 'Not signed in');
    return false;
  }
  if (!isDemoOperator(login)) {
    send(reply, 403, 'forbidden', 'Only demo operators can do this');
    return false;
  }
  return true;
}

/** Priorities belong to the posting's employer (as a demo identity) or a demo operator. */
async function requirePriorityEditor(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const identity = await currentDemoIdentity(request);
  const id = (request.params as { id?: unknown }).id;
  if (identity?.kind === 'employer' && typeof id === 'string') {
    const [job] = await db
      .select({ employerId: demoJobs.employerId })
      .from(demoJobs)
      .where(eq(demoJobs.id, id));
    if (job?.employerId === identity.key) return true;
  }
  return requireOperator(request, reply);
}

// The list never loads resume text.
const summaryColumns = {
  key: demoCandidates.key,
  name: demoCandidates.name,
  githubUrl: demoCandidates.githubUrl,
  githubLogin: demoCandidates.githubLogin,
  organization: demoCandidates.organization,
  repositories: demoCandidates.repositories,
  resumeUrl: demoCandidates.resumeUrl,
  resumeType: demoCandidates.resumeType,
  resumeSource: demoCandidates.resumeSource,
  resumeStatus: demoCandidates.resumeStatus,
  resumeReviewReason: demoCandidates.resumeReviewReason,
  resumePages: demoCandidates.resumePages,
  runStatus: demoCandidates.runStatus,
  runError: demoCandidates.runError,
  selectionCheckedAt: demoCandidates.selectionCheckedAt,
};
type SummaryRow = Pick<CandidateRow, keyof typeof summaryColumns>;

/** Active selected repositories per demo candidate, from the selection grading uses. */
async function selectionCounts(): Promise<Map<string, number>> {
  const rows = await db
    .select({ key: repositorySelections.subjectKey, n: sql<number>`count(*)::int` })
    .from(repositorySelections)
    .where(
      and(eq(repositorySelections.subjectKind, 'demo'), eq(repositorySelections.active, true)),
    )
    .groupBy(repositorySelections.subjectKey);
  return new Map(rows.map((r) => [r.key, r.n]));
}

function candidateSummary(row: SummaryRow, selected: number): DemoCandidateSummary {
  const source = row.resumeSource as ResumeSource | null;
  return {
    key: row.key,
    name: row.name,
    githubUrl: row.githubUrl,
    githubLogin: row.githubLogin,
    organization: row.organization,
    repositoryCount: row.selectionCheckedAt || selected > 0 ? selected : null,
    resume: {
      status: row.resumeStatus,
      reviewReason: row.resumeReviewReason,
      kind: source?.kind ?? null,
      limitedSource: source?.limitedSource ?? false,
      sources: source?.sources ?? [],
      limitations: source?.limitations ?? [],
      pages: row.resumePages,
      resumeUrl: row.resumeUrl,
      resumeType: row.resumeType,
    },
    run: { status: row.runStatus, errorCode: row.runError },
  };
}

/** Reassessment hints per selected repository; none of them starts any work. */
async function repositoryFlags(
  row: CandidateRow,
  state: Awaited<ReturnType<typeof candidateState>>,
): Promise<Map<number, RepositoryFlag[]>> {
  const provenance = await repositoryProvenance({ kind: 'demo', key: row.key });
  const resume = row.resumeStatus === 'extracted' && row.resumeText ? sha256Hex(row.resumeText) : null;
  const out = new Map<number, RepositoryFlag[]>();
  for (const s of state.selection) {
    const p = provenance.get(s.repoId);
    const entry = state.manifest?.repos.find((m) => m.repo.toLowerCase() === s.fullName.toLowerCase());
    const flags: RepositoryFlag[] = [];
    if (s.pushedAt && s.assessedAt && s.pushedAt > s.assessedAt) flags.push('changed_since_assessed');
    if (p?.resumeSha256.some((h) => h !== resume)) flags.push('resume_changed');
    if (p?.attribution.includes('limited')) flags.push('attribution_limited');
    if (entry?.unavailable === 'legacy_split') flags.push('legacy_split');
    out.set(s.repoId, flags);
  }
  return out;
}

async function candidateDetail(row: CandidateRow): Promise<DemoCandidate> {
  const current = await candidateState(row);
  // The checked-in seed predates the current catalogue. Older markers are display-only.
  const historical = !row.organization && !current.assessment && env.META_MODEL
    ? await latestSaved('candidate', { kind: 'demo', key: row.key }, env.META_MODEL)
    : undefined;
  const state = historical ? {
    ...current,
    assessment: CandidateAssessmentSchema.parse(historical.result),
    manifest: historical.inputManifest,
    freshness: { ...current.freshness, state: 'outdated' as const },
  } : current;
  const flags = await repositoryFlags(row, state);
  const pins = new Map(row.repositories.map((r) => [`${r.owner}/${r.repo}`.toLowerCase(), r.pinnedSha]));
  // Older seed snapshots lack a manifest. Use only their saved evidence to recover display metadata.
  const historicalRepos = new Map<string, { repo: string; commitSha: string | null; unavailable: null }>();
  for (const finding of state.assessment?.repositories ?? []) {
    historicalRepos.set(finding.repo.toLowerCase(), { repo: finding.repo, commitSha: null, unavailable: null });
  }
  for (const skill of state.assessment?.skills ?? []) {
    for (const ref of skill.evidence) {
      historicalRepos.set(ref.repo.toLowerCase(), { repo: ref.repo, commitSha: ref.commitSha, unavailable: null });
    }
  }
  const manifest = state.manifest ?? (historicalRepos.size > 0 ? {
    repos: [...historicalRepos.values()], resumeSha256: null,
  } : null);
  const repositories = state.selection.map((sel) => {
    const [owner, repo] = sel.fullName.split('/') as [string, string];
    return { owner, repo, pinnedSha: pins.get(sel.fullName.toLowerCase()) ?? null,
      repoId: sel.repoId as number | null, flags: flags.get(sel.repoId) ?? [] };
  });
  const shown = new Set(repositories.map(({ owner, repo }) => `${owner}/${repo}`.toLowerCase()));
  for (const name of [...(manifest?.repos.map((r) => r.repo) ?? []),
    ...(repositories.length === 0 ? row.repositories.map((r) => `${r.owner}/${r.repo}`) : [])]) {
    if (shown.has(name.toLowerCase())) continue;
    const [owner, repo] = name.split('/');
    if (!owner || !repo) continue;
    shown.add(name.toLowerCase());
    repositories.push({ owner, repo, pinnedSha: pins.get(name.toLowerCase()) ?? null, repoId: null, flags: [] });
  }
  const verification = row.verification as DemoCandidate['verification'];
  return {
    ...candidateSummary(row, state.selection.length),
    resumeText: row.resumeStatus === 'extracted' ? row.resumeText : null,
    verification: {
      identityMatchVerified: verification.identityMatchVerified,
      publicRepositoriesVerified: verification.publicRepositoriesVerified,
      source: verification.source,
      userSuppliedStatus: verification.userSuppliedStatus,
    },
    freshness: state.freshness,
    transientRepos: (state.manifest?.repos ?? []).flatMap((r) =>
      r.unavailable && TRANSIENT.has(r.unavailable) ? [r.repo] : [],
    ),
    repositories: buildRepositoryBreakdown({
      repositories,
      manifest,
      freshness: state.assessment ? { ...state.freshness, state: 'current' } : state.freshness,
      assessment: state.assessment,
    }),
  };
}

type JobWithEmployer = { job: JobRow; employer: typeof demoEmployers.$inferSelect };

function jobSummary({ job, employer }: JobWithEmployer): DemoJobSummary {
  return {
    id: job.id,
    title: job.title,
    employer: {
      id: employer.id,
      name: employer.name,
      url: employer.url,
      description: employer.description,
      location: employer.location,
    },
    location: job.location,
    sourceUrl: job.sourceUrl,
    sourceChecked: job.sourceChecked,
    inScope: job.inScope,
    textSource: job.textSource,
    run: { status: job.runStatus, errorCode: job.runError },
  };
}

async function jobDetail(row: JobWithEmployer): Promise<DemoJob> {
  const state = await jobState(row.job);
  const overrides = state.assessment ? await priorityOverrides(row.job.id) : new Map();
  return {
    ...jobSummary(row),
    text: row.job.text,
    formatted: formatPosting(row.job),
    retrievedOn: row.job.retrievedOn,
    sourceLimitations: row.job.sourceLimitations,
    freshness: state.freshness,
    requirements: (state.assessment?.requirements ?? []).map((r) => {
      const override = overrides.get(r.skillId);
      return {
        skillId: r.skillId,
        name: SKILL_NAMES.get(r.skillId) ?? r.skillId,
        requiredLevel: r.requiredLevel,
        suggestedPriority: r.suggestedPriority,
        referenceStatus: r.referenceStatus,
        priority: override ?? r.suggestedPriority,
        prioritySource: override === undefined ? 'suggested' : 'override',
      };
    }),
  };
}

const jobsWithEmployers = () =>
  db
    .select({ job: demoJobs, employer: demoEmployers })
    .from(demoJobs)
    .innerJoin(demoEmployers, eq(demoJobs.employerId, demoEmployers.id));

const KeyParams = z.object({ key: z.string().min(1) });
const IdParams = z.object({ id: z.string().min(1) });
const PriorityParams = z.object({ id: z.string().min(1), skillId: SkillIdSchema });
const MatchQuery = z.object({ candidate: z.string().min(1), job: z.string().min(1) });
const AnalysisBody = z
  .object({ retry: z.boolean().optional(), fresh: z.boolean().optional() })
  .strict();
const PriorityBody = z.object({ priority: PrioritySchema.nullable() }).strict();

export async function demoRoutes(app: FastifyInstance) {
  // Only safe codes and count outcomes: errors from a run can carry request details.
  const deps = loggedDeps(app.log);

  const started = (reply: FastifyReply, run: Started) => {
    const body: AnalysisStart = { result: run.result };
    return reply.code(run.result === 'started' ? 202 : 200).send(body);
  };

  app.get('/demo/candidates', async () => {
    const rows = await db.select(summaryColumns).from(demoCandidates).orderBy(demoCandidates.name);
    const counts = await selectionCounts();
    return rows.map((row) => candidateSummary(row, counts.get(row.key) ?? 0));
  });

  app.get('/demo/candidates/:key', async (request, reply) => {
    const params = KeyParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, 'invalid_input', 'Invalid candidate key');
    const [row] = await db
      .select()
      .from(demoCandidates)
      .where(eq(demoCandidates.key, params.data.key));
    if (!row) return send(reply, 404, 'not_found', 'No demo candidate with this key');
    return candidateDetail(row);
  });

  app.get('/demo/jobs', async () => {
    const rows = await jobsWithEmployers().orderBy(demoJobs.id);
    return rows.map(jobSummary);
  });

  app.get('/demo/jobs/:id', async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, 'invalid_input', 'Invalid job id');
    const [row] = await jobsWithEmployers().where(eq(demoJobs.id, params.data.id));
    if (!row) return send(reply, 404, 'not_found', 'No demo job with this id');
    return jobDetail(row);
  });

  app.get('/demo/match', async (request, reply) => {
    const query = MatchQuery.safeParse(request.query);
    if (!query.success) return send(reply, 400, 'invalid_input', 'Pass candidate and job');
    const [candidate] = await db
      .select()
      .from(demoCandidates)
      .where(eq(demoCandidates.key, query.data.candidate));
    const [job] = await db.select().from(demoJobs).where(eq(demoJobs.id, query.data.job));
    if (!candidate || !job) return send(reply, 404, 'not_found', 'Unknown candidate or job');
    return demoMatch(candidate, job);
  });

  app.post('/demo/candidates/:key/analysis', async (request, reply) => {
    if (!(await requireOperator(request, reply))) return reply;
    const github = await signedInGitHub(request, reply, true);
    if (!github) return reply;
    const params = KeyParams.safeParse(request.params);
    const body = AnalysisBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return send(reply, 400, 'invalid_input', 'Invalid analysis request');
    }
    const run = await startCandidateRun(
      params.data.key,
      { retry: body.data.retry ?? false, fresh: body.data.fresh ?? false },
      { ...deps, octokit: () => github.octokit, manualRetry: true },
    );
    return started(reply, run);
  });

  /**
   * An explicit regrade: grades the selected repositories that need work (new, unfinished or
   * failed), reusing every processed result. With `repoIds`, those repositories are graded anew at
   * their current head, superseding their earlier results once complete.
   */
  app.post(
    '/demo/candidates/:key/rerun',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const github = await signedInGitHub(request, reply, true);
      if (!github) return reply;
      const params = KeyParams.safeParse(request.params);
      const body = RerunBodySchema.safeParse(request.body ?? {});
      if (!params.success || !body.success) {
        return send(reply, 400, 'invalid_input', 'Invalid regrade request');
      }
      const run = await startCandidateRun(
        params.data.key,
        { retry: true, ...(body.data.repoIds && { repoIds: body.data.repoIds }) },
        { ...deps, octokit: () => github.octokit, manualRetry: true },
      );
      return started(reply, run);
    },
  );

  /** A seeker disputes one marker; the justification is investigated, never taken as evidence. */
  app.post(
    '/demo/candidates/:key/reassessments',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const github = await signedInGitHub(request, reply, true);
      if (!github) return reply;
      const params = KeyParams.safeParse(request.params);
      const body = ReassessmentBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return send(reply, 400, 'invalid_input', 'Invalid reassessment request');
      }
      const run = await startReassessment(params.data.key, body.data, { ...deps, octokit: () => github.octokit, manualRetry: true });
      return started(reply, run);
    },
  );

  app.post('/demo/jobs/:id/analysis', async (request, reply) => {
    if (!(await requireOperator(request, reply))) return reply;
    const params = IdParams.safeParse(request.params);
    const body = AnalysisBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return send(reply, 400, 'invalid_input', 'Invalid analysis request');
    }
    const run = await startJobRun(
      params.data.id,
      { retry: body.data.retry ?? false, fresh: body.data.fresh ?? false },
      deps,
    );
    return started(reply, run);
  });

  /** Priorities are edited only on an in-scope posting with a current analysis. */
  async function editableJob(reply: FastifyReply, id: string) {
    const [row] = await jobsWithEmployers().where(eq(demoJobs.id, id));
    if (!row) {
      send(reply, 404, 'not_found', 'No demo job with this id');
      return null;
    }
    if (!row.job.inScope) {
      send(reply, 409, 'out_of_scope', 'This posting is out of scope');
      return null;
    }
    const state = await jobState(row.job);
    if (!state.assessment) {
      send(reply, 409, 'job_not_current', 'Analyze this job before changing priorities');
      return null;
    }
    return { row, assessment: state.assessment };
  }

  app.put('/demo/jobs/:id/priorities/:skillId', async (request, reply) => {
    if (!(await requirePriorityEditor(request, reply))) return reply;
    const params = PriorityParams.safeParse(request.params);
    const body = PriorityBody.safeParse(request.body);
    if (!params.success || !body.success) {
      return send(reply, 400, 'invalid_input', 'Invalid priority change');
    }
    const editable = await editableJob(reply, params.data.id);
    if (!editable) return reply;
    const { row, assessment } = editable;
    if (!assessment.requirements.some((r) => r.skillId === params.data.skillId)) {
      return send(reply, 422, 'not_a_requirement', 'This skill is not a requirement of the job');
    }
    const { id, skillId } = params.data;
    if (body.data.priority === null) await clearPriorityOverride(id, skillId);
    else await setPriorityOverride({ jobKey: id, skillId, priority: body.data.priority });
    return jobDetail(row);
  });

  app.delete('/demo/jobs/:id/priorities', async (request, reply) => {
    if (!(await requirePriorityEditor(request, reply))) return reply;
    const params = IdParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, 'invalid_input', 'Invalid job id');
    const editable = await editableJob(reply, params.data.id);
    if (!editable) return reply;
    // One statement, so every override is reset together.
    await db.delete(jobPriorityOverrides).where(eq(jobPriorityOverrides.jobKey, params.data.id));
    return jobDetail(editable.row);
  });
}
