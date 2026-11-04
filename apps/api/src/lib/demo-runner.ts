// Starts demo analyses. A run is claimed before the caller hears 202; every later write is
// conditional on that run's token, so a stale worker can neither overwrite a newer run nor start a
// paid request. Repository code is fetched per run and only held in memory. Assessment locks,
// caching and spend caps stay in analyzeCandidate/analyzeJob. The worker grades each subject that
// has no result yet, a few at a time; failures are never retried automatically.
import type { Octokit } from '@octokit/rest';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, like, lt, lte, ne, notInArray, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { demoCandidates, demoJobs, repositorySelections, skillAssessments } from '../db/schema.js';
import { env } from '../env.js';
import {
  activeSelection,
  analyzeJob,
  analyzeReassessment,
  combineCandidate,
  HEARTBEAT_MS,
  recoverStaleAssessments,
  syncLegacy,
  type RunOptions,
} from './assessments.js';
import { EvidenceInputError, type PreparedCandidate } from './candidate-evidence.js';
import { collectContributions, DEFAULT_COLLECT_LIMITS, pinHistory } from './contributions.js';
import { demoOctokit, PreparationError, resolveIdentity, RUN_STALE_MS } from './demo-prepare.js';
import {
  candidateInput,
  candidateState,
  jobInput,
  jobState,
  type CandidateRow,
} from './demo-results.js';
import { downloadArchive, fetchFiles, IngestError, listTree } from './ingest.js';
import { MuseError } from './muse.js';
import { contextPaths } from './packets.js';
import {
  assertGitHubAvailable,
  GITHUB_TRANSIENT,
  MAX_CONTEXT_FILES,
  MAX_GITHUB_FAILURES,
  needsWork,
  noteQuota,
  processRepository,
  recordFailure,
  requestFresh,
  requirePublicRepository,
  type RepositoryContext,
} from './repository-runs.js';
import { listPublicRepos, pickDefaults, refreshPushedAt, saveSelection } from './repository-selection.js';

/** A refusal the route reports as 404 or 409 with this code. */
export class RunError extends Error {
  readonly statusCode: number;
  constructor(
    readonly code:
      | 'not_found'
      | 'no_selected_repositories'
      | 'not_selected'
      | 'not_assessed'
      | 'organization_account'
      | 'out_of_scope'
      | 'model_not_configured'
      | 'in_progress'
      | 'previous_failure',
    message: string,
  ) {
    super(message);
    this.statusCode = code === 'not_found' ? 404 : 409;
  }
}

export interface RunDeps {
  octokit?: () => Octokit;
  /** Passed to analyze*: tests inject fetch, sleep and a budget namespace. */
  runOptions?: RunOptions;
  onError?: (err: unknown) => void;
  /** Limits the worker to subject keys with this prefix; tests share the demo database. */
  scope?: string;
  manualRetry?: boolean;
}

export interface Started {
  result: 'started' | 'cached';
  /** Settles when the worker finishes; never rejects. Undefined when cached. */
  done?: Promise<void>;
}

type Table = typeof demoCandidates | typeof demoJobs;
const keyColumn = (table: Table) => (table === demoCandidates ? demoCandidates.key : demoJobs.id);

interface Logger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

/** Run failures as safe codes and each token count's outcome, category and timing; no contents. */
export function loggedDeps(log: Logger): RunDeps {
  return {
    onError: (err) => log.warn({ code: safeErrorCode(err) }, 'Demo analysis failed'),
    runOptions: { onCount: (outcome) => log.info({ count: outcome }, 'Muse token count') },
  };
}

/** Safe, fixed error codes only: exception messages never reach stored state or clients. */
export function safeErrorCode(err: unknown): string {
  if (err instanceof IngestError && err.status === 401) return 'github_reconnect';
  if (err instanceof MuseError || err instanceof IngestError || err instanceof RunError) {
    return err.code;
  }
  if (err instanceof PreparationError) return err.code;
  if (err instanceof EvidenceInputError) return 'invalid_evidence';
  return 'internal_error';
}

function requireModel(deps: RunDeps) {
  if (!(deps.runOptions?.model ?? env.META_MODEL) || !env.META_API_KEY) {
    throw new RunError('model_not_configured', 'Muse is not configured on the API');
  }
}

/** Marks a run whose worker stopped heartbeating as interrupted; never resends anything. */
async function recoverRun(table: Table, key?: string): Promise<void> {
  const stale = and(
    eq(table.runStatus, 'pending'),
    or(
      sql`${table.runHeartbeatAt} is null`,
      lt(table.runHeartbeatAt, new Date(Date.now() - RUN_STALE_MS)),
    ),
  );
  await db
    .update(table)
    .set({ runStatus: 'failed', runError: 'interrupted', runId: null })
    .where(key === undefined ? stale : and(eq(keyColumn(table), key), stale));
}

export async function recoverStaleRuns(): Promise<void> {
  await recoverStaleAssessments();
  await recoverRun(demoCandidates);
  await recoverRun(demoJobs);
}

async function claimRun(table: Table, key: string, retry: boolean): Promise<string> {
  const token = randomUUID();
  const waiting = or(eq(table.runStatus, 'idle'), eq(table.runStatus, 'queued'));
  const claimable = retry ? or(waiting, eq(table.runStatus, 'failed')) : waiting;
  const claimed = await db
    .update(table)
    .set({
      runStatus: 'pending',
      runId: token,
      runError: null,
      runHeartbeatAt: new Date(),
      queuedAt: null,
    })
    .where(and(eq(keyColumn(table), key), claimable))
    .returning({ runId: table.runId });
  if (claimed.length > 0) return token;
  const [row] = await db
    .select({ runStatus: table.runStatus, runError: table.runError })
    .from(table)
    .where(eq(keyColumn(table), key));
  if (row?.runStatus === 'pending')
    throw new RunError('in_progress', 'An analysis is already running');
  throw new RunError('previous_failure', 'The previous run failed; use Retry to run it again');
}

/**
 * Runs `work` while owning the run; heartbeats, then records success or a safe failure code. Work
 * that returns a time is queued again for then (a GitHub quota reset or a transient retry).
 */
function runOwned(
  table: Table,
  key: string,
  token: string,
  deps: RunDeps,
  work: (owned: () => Promise<boolean>) => Promise<{ at: Date; reason: string } | void>,
): Promise<void> {
  const owner = and(
    eq(keyColumn(table), key),
    eq(table.runId, token),
    eq(table.runStatus, 'pending'),
  );
  const touch = async () =>
    (
      await db
        .update(table)
        .set({ runHeartbeatAt: new Date() })
        .where(owner)
        .returning({ id: table.runId })
    ).length > 0;
  const heartbeat = setInterval(() => void touch().catch(() => {}), HEARTBEAT_MS);
  const finish = (fields: {
    runStatus: 'idle' | 'failed' | 'queued';
    runError: string | null;
    queuedAt?: Date;
  }) => db.update(table).set(fields).where(owner);
  return (async () => {
    try {
      const later = await work(touch);
      await finish(
        later
          ? deps.manualRetry
            ? { runStatus: 'failed', runError: later.reason }
            : { runStatus: 'queued', runError: later.reason, queuedAt: later.at }
          : { runStatus: 'idle', runError: null },
      );
    } catch (err) {
      deps.onError?.(err);
      await finish({ runStatus: 'failed', runError: safeErrorCode(err) }).catch(() => {});
    } finally {
      clearInterval(heartbeat);
    }
  })();
}

class OwnershipLost extends Error {}

/**
 * `retry` may restart a failed run; `fresh` (an explicit regrade) also skips any saved result for
 * unchanged inputs, so the subject is fetched and graded again.
 */
export interface StartOptions {
  retry: boolean;
  fresh?: boolean;
  /** Regrades only these selected repositories, fresh at their current head. */
  repoIds?: number[];
  /** Started by the worker: failed paid requests and permanent failures are never retried. */
  automatic?: boolean;
}

// ---- Candidates ----

const demoSubject = (key: string) => ({ kind: 'demo' as const, key });

/** Nothing to grade: defaults were chosen, no repository needs work, and the markers are current. */
async function upToDate(row: CandidateRow, deps: RunDeps): Promise<boolean> {
  if (!row.selectionCheckedAt) return false;
  const selection = await activeSelection(demoSubject(row.key));
  if (selection.some((s) => needsWork(s, 'explicit'))) return false;
  return (await candidateState(row, deps.runOptions)).freshness.state === 'current';
}

export async function startCandidateRun(
  key: string,
  { retry, fresh = false, repoIds, automatic = false }: StartOptions,
  deps: RunDeps = {},
): Promise<Started> {
  const [row] = await db.select().from(demoCandidates).where(eq(demoCandidates.key, key));
  if (!row) throw new RunError('not_found', 'No demo candidate with this key');
  if (row.organization) {
    throw new RunError(
      'organization_account',
      'Organization accounts are not analysed as a person',
    );
  }
  requireModel(deps);
  const subject = demoSubject(key);
  const selection = await activeSelection(subject);
  if (row.selectionCheckedAt && selection.length === 0) {
    throw new RunError('no_selected_repositories', 'This profile has no public repositories to grade');
  }
  if (repoIds?.some((id) => !selection.some((s) => s.repoId === id))) {
    throw new RunError('not_selected', 'Only selected repositories can be regraded');
  }
  for (const kind of ['candidate', 'repository'] as const) {
    await recoverStaleAssessments({ kind, subjectKind: 'demo', subjectKey: key });
  }
  await recoverRun(demoCandidates, key);
  if (!fresh && !repoIds && (await upToDate(row, deps))) return { result: 'cached' };

  const token = await claimRun(demoCandidates, key, retry || fresh || repoIds !== undefined);
  const done = runOwned(demoCandidates, key, token, deps, (owned) =>
    gradeCandidate(key, { fresh, repoIds, automatic }, deps, owned),
  );
  return { result: 'started', done };
}

/** The quota reset an error asks to wait for, or null when it is not a GitHub quota response. */
function quotaWait(err: unknown): Date | null {
  noteQuota(err);
  return err instanceof IngestError && err.code === 'rate_limited'
    ? new Date(err.resetAt ?? Date.now() + 60_000)
    : null;
}

/**
 * Chooses demo defaults once (metadata only), refreshes change hints, then grades each selected
 * repository that needs work, saving every processed request as it goes. A GitHub quota response
 * stops the run and queues it for the reset; completed work is kept. The combined markers are
 * rebuilt from the selection at the end, so a removed repository no longer contributes.
 */
async function gradeCandidate(
  key: string,
  mode: { fresh: boolean; repoIds: number[] | undefined; automatic: boolean },
  deps: RunDeps,
  owned: () => Promise<boolean>,
): Promise<{ at: Date; reason: string } | void> {
  const [current] = await db.select().from(demoCandidates).where(eq(demoCandidates.key, key));
  if (!current) throw new RunError('not_found', 'No demo candidate with this key');
  // Held only in memory for this run; never written anywhere.
  const octokit = (deps.octokit ?? demoOctokit)();
  const subject = demoSubject(key);
  const resumeText = candidateInput(current).resumeText;
  const runOptions = deps.runOptions ?? {};
  if (mode.fresh || mode.repoIds) await requestFresh(subject, mode.repoIds);
  let ctx: RepositoryContext;
  try {
    assertGitHubAvailable();
    const identity = await resolveIdentity(octokit, current.githubLogin);
    const listing = await listPublicRepos(octokit, current.githubLogin);
    if (!current.selectionCheckedAt) {
      await saveSelection(subject, pickDefaults(listing), 'demo_default');
    } else {
      await refreshPushedAt(subject, listing);
    }
    await db
      .update(demoCandidates)
      .set({
        selectionCheckedAt: current.selectionCheckedAt ?? new Date(),
        metadataRefreshedAt: new Date(),
      })
      .where(eq(demoCandidates.key, key));
    ctx = { subject, identity, resumeText, dataUse: 'approved_public_demo', publicOnly: deps.manualRetry };
  } catch (err) {
    const at = quotaWait(err);
    if (at) return { at, reason: 'rate_limited' };
    throw err;
  }

  await syncLegacy(subject, resumeText, runOptions);
  let wait: Date | null = null;
  let manualFailure: unknown;
  for (const s of await activeSelection(subject)) {
    // A requested regrade is recorded on the repository, so a resumed run still honours it.
    const targeted = s.freshRequestedAt !== null;
    if (!targeted && !needsWork(s, mode.automatic ? 'automatic' : 'explicit')) continue;
    // A worker whose claim was recovered or superseded must not start a paid request.
    if (!(await owned())) throw new OwnershipLost();
    try {
      await processRepository(
        octokit,
        ctx,
        s,
        { fresh: targeted, automatic: mode.automatic, owned },
        runOptions,
      );
    } catch (err) {
      // A superseded run stops at once and writes nothing more.
      if (!(await owned())) throw new OwnershipLost();
      wait = quotaWait(err);
      if (wait) break;
      deps.onError?.(err);
      manualFailure = err;
      await recordFailure(s, safeErrorCode(err));
      // The allowance or configuration stops every repository alike.
      if (err instanceof MuseError && ['budget_exceeded', 'not_configured'].includes(err.code)) break;
    }
  }
  if (deps.manualRetry) {
    if (wait) return { at: wait, reason: 'rate_limited' };
    if (manualFailure) throw manualFailure;
  }
  await syncLegacy(subject, resumeText, runOptions);
  await combineCandidate(subject, resumeText, runOptions);
  if (wait) return { at: wait, reason: 'rate_limited' };
  // A few transient GitHub failures are retried automatically, with backoff.
  const transient = (await activeSelection(subject)).filter(
    (s) =>
      s.lastError !== null &&
      GITHUB_TRANSIENT.has(s.lastError) &&
      s.githubFailures < MAX_GITHUB_FAILURES,
  );
  if (transient.length > 0) {
    const failures = Math.max(...transient.map((s) => s.githubFailures));
    return { at: new Date(Date.now() + 5 * 60_000 * 3 ** (failures - 1)), reason: 'retry_scheduled' };
  }
}

export interface ReassessmentInput {
  skillId: string;
  repoIds: number[];
  paths: string[];
  justification: string;
}

/**
 * Re-examines one disputed marker in the named selected repositories at their current head: the
 * requested files, the files the marker currently cites, and their imports, tests and manifests.
 * Runs as the candidate's run, so it never overlaps grading.
 */
export async function startReassessment(
  key: string,
  input: ReassessmentInput,
  deps: RunDeps = {},
): Promise<Started> {
  const [row] = await db.select().from(demoCandidates).where(eq(demoCandidates.key, key));
  if (!row) throw new RunError('not_found', 'No demo candidate with this key');
  requireModel(deps);
  const subject = demoSubject(key);
  const selection = await activeSelection(subject);
  const chosen = input.repoIds.map((id) => selection.find((s) => s.repoId === id));
  if (chosen.some((s) => !s)) throw new RunError('not_selected', 'Only selected repositories can be reassessed');
  if (chosen.some((s) => !s!.assessedCommit && !s!.legacyAssessmentId)) {
    throw new RunError('not_assessed', 'A repository must be graded before it can be reassessed');
  }
  await recoverRun(demoCandidates, key);
  const token = await claimRun(demoCandidates, key, true);
  const done = runOwned(demoCandidates, key, token, deps, async (owned) => {
    const [current] = await db.select().from(demoCandidates).where(eq(demoCandidates.key, key));
    if (!current) throw new RunError('not_found', 'No demo candidate with this key');
    const octokit = (deps.octokit ?? demoOctokit)();
    const runOptions = deps.runOptions ?? {};
    const resumeText = candidateInput(current).resumeText;
    const state = await candidateState(current, runOptions);
    const marker = state.assessment?.skills.find((s) => s.skillId === input.skillId);
    try {
      assertGitHubAvailable();
      const identity = await resolveIdentity(octokit, current.githubLogin);
      for (const s of chosen as NonNullable<(typeof chosen)[number]>[]) {
        const [owner, repo] = s.fullName.split('/') as [string, string];
        if (deps.manualRetry) await requirePublicRepository(octokit, owner, repo, s.repoId);
        const priorPaths = [
          ...new Set(
            (marker?.evidence ?? [])
              .filter((e) => e.repo.toLowerCase() === s.fullName.toLowerCase())
              .map((e) => e.path),
          ),
        ];
        const pinned = await pinHistory(octokit, { owner, repo });
        const tree = await listTree(octokit, { owner, repo }, pinned);
        const byPath = new Map(tree.kept.map((e) => [e.path, e]));
        const wanted = [...new Set([...input.paths, ...priorPaths])].filter((p) => byPath.has(p));
        if (wanted.length === 0) continue;
        const archive = await downloadArchive(octokit, { owner, repo }, tree);
        const files = (paths: string[]) =>
          fetchFiles(octokit, { owner, repo }, paths.map((p) => byPath.get(p)!), undefined, archive);
        const core = await files(wanted);
        const context = await files(
          contextPaths(core.files, [...byPath.keys()]).slice(0, MAX_CONTEXT_FILES),
        );
        const collected = await collectContributions(
          octokit,
          { owner, repo, commitSha: tree.commitSha },
          identity,
          [...byPath.keys()],
          DEFAULT_COLLECT_LIMITS,
          pinned,
        );
        const prepared: PreparedCandidate = {
          subject,
          identity,
          repos: [
            {
              owner,
              repo,
              collectedFor: identity.githubUserId,
              snapshot: {
                commitSha: tree.commitSha,
                files: [...core.files, ...context.files].sort((a, b) => (a.path < b.path ? -1 : 1)),
                skipped: [...tree.skipped, ...core.skipped, ...context.skipped],
              },
              collected,
            },
          ],
          resume: resumeText === null ? null : { text: resumeText },
          dataUse: 'approved_public_demo',
        };
        if (!(await owned())) throw new OwnershipLost();
        await analyzeReassessment(
          {
            prepared,
            repoId: s.repoId,
            skillId: input.skillId,
            justification: input.justification,
            paths: wanted,
            priorPaths,
          },
          runOptions,
        );
      }
    } catch (err) {
      const at = quotaWait(err);
      // A reassessment is never resumed on its own: the seeker asks again after the reset.
      if (at) throw new IngestError('rate_limited', 'GitHub quota exhausted', 429, at.getTime());
      throw err;
    } finally {
      // A re-examined marker that spanned repositories releases the others for their own grading.
      await syncLegacy(subject, resumeText, runOptions);
      await combineCandidate(subject, resumeText, runOptions);
    }
  });
  return { result: 'started', done };
}

// ---- Jobs ----

export async function startJobRun(
  id: string,
  { retry, fresh = false }: StartOptions,
  deps: RunDeps = {},
): Promise<Started> {
  const [row] = await db.select().from(demoJobs).where(eq(demoJobs.id, id));
  if (!row) throw new RunError('not_found', 'No demo job with this id');
  if (!row.inScope) throw new RunError('out_of_scope', 'Out-of-scope postings are not analysed');
  requireModel(deps);
  await recoverStaleAssessments({ kind: 'job', subjectKind: 'demo', subjectKey: id });
  await recoverRun(demoJobs, id);
  if (!fresh && (await jobState(row, deps.runOptions)).freshness.state === 'current') {
    return { result: 'cached' };
  }

  const token = await claimRun(demoJobs, id, retry || fresh);
  const done = runOwned(demoJobs, id, token, deps, async (owned) => {
    const [current] = await db.select().from(demoJobs).where(eq(demoJobs.id, id));
    if (!current) throw new RunError('not_found', 'No demo job with this id');
    if (!(await owned())) throw new OwnershipLost();
    await analyzeJob(
      { ...jobInput(current), dataUse: 'approved_public_demo' },
      { ...deps.runOptions, retryFailed: retry || fresh, fresh },
    );
  });
  return { result: 'started', done };
}

// ---- Analysis worker ----

const SAVED_STATUSES = sql`('complete', 'partial', 'no_attributed_evidence')`;
export const WORKER_INTERVAL_MS = 10_000;

/**
 * Queues every subject that has never been graded: in-scope jobs with retrieved posting text, and
 * complete candidate profiles without a result from a live run. Outdated or failed subjects wait
 * for an explicit regrade, so nothing is re-sent automatically.
 */
async function enqueueUngraded(deps: RunDeps): Promise<void> {
  const queued = { runStatus: 'queued' as const, queuedAt: new Date() };
  const inScope = (table: Table) =>
    deps.scope ? like(keyColumn(table), `${deps.scope}%`) : undefined;
  await db
    .update(demoJobs)
    .set(queued)
    .where(
      and(
        inScope(demoJobs),
        eq(demoJobs.inScope, true),
        eq(demoJobs.runStatus, 'idle'),
        // Abbreviated notes are never graded automatically.
        ne(demoJobs.textSource, 'fixture_summary'),
        sql`not exists (select 1 from ${skillAssessments} where ${skillAssessments.kind} = 'job'
          and ${skillAssessments.subjectKind} = 'demo' and ${skillAssessments.subjectKey} = ${demoJobs.id}
          and ${skillAssessments.status} in ${SAVED_STATUSES})`,
      ),
    );
  // Unauthenticated GitHub allows 60 requests an hour, too few for a repository fetch.
  if (!deps.octokit) return;
  // Defaults not chosen yet, or a selected repository never graded, unfinished, or released from
  // an older result. Failed repositories wait for an explicit regrade.
  const r = repositorySelections;
  await db
    .update(demoCandidates)
    .set(queued)
    .where(
      and(
        inScope(demoCandidates),
        eq(demoCandidates.organization, false),
        eq(demoCandidates.runStatus, 'idle'),
        or(
          sql`${demoCandidates.selectionCheckedAt} is null`,
          sql`exists (select 1 from ${r} where ${r.subjectKind} = 'demo'
            and ${r.subjectKey} = ${demoCandidates.key} and ${r.active}
            and ${r.lastError} is null and (${r.freshRequestedAt} is not null
              or (${r.legacyAssessmentId} is null
                and (${r.progress} is not null or ${r.assessedCommit} is null))))`,
        ),
      ),
    );
}

interface Queued {
  table: Table;
  key: string;
  start: () => Promise<Started>;
}

/** The oldest queued subject not in `active`; jobs first, since they are small. */
async function nextQueued(deps: RunDeps, active: ReadonlySet<string>): Promise<Queued | null> {
  const queuedIn = (table: Table) =>
    and(
      eq(table.runStatus, 'queued'),
      deps.scope ? like(keyColumn(table), `${deps.scope}%`) : undefined,
      active.size > 0 ? notInArray(keyColumn(table), [...active]) : undefined,
      // Work waiting for a GitHub quota reset or a retry time never blocks other subjects.
      lte(table.queuedAt, new Date()),
    );
  const [job] = await db
    .select({ id: demoJobs.id })
    .from(demoJobs)
    .where(queuedIn(demoJobs))
    .orderBy(asc(demoJobs.queuedAt))
    .limit(1);
  const [candidate] = job
    ? []
    : await db
        .select({ key: demoCandidates.key })
        .from(demoCandidates)
        .where(queuedIn(demoCandidates))
        .orderBy(asc(demoCandidates.queuedAt))
        .limit(1);
  return job
    ? { table: demoJobs, key: job.id, start: () => startJobRun(job.id, { retry: false }, deps) }
    : candidate
      ? {
          table: demoCandidates,
          key: candidate.key,
          start: () => startCandidateRun(candidate.key, { retry: false, automatic: true }, deps),
        }
      : null;
}

/** Runs one queued subject to completion. */
async function runQueued(next: Queued, deps: RunDeps): Promise<void> {
  const stillQueued = and(eq(keyColumn(next.table), next.key), eq(next.table.runStatus, 'queued'));
  try {
    const run = await next.start();
    if (run.done) await run.done;
    else await db.update(next.table).set({ runStatus: 'idle', queuedAt: null }).where(stillQueued);
  } catch (err) {
    // Refused before a claim: the subject leaves the queue with the reason.
    deps.onError?.(err);
    await db
      .update(next.table)
      .set({ runStatus: 'failed', runError: safeErrorCode(err), queuedAt: null })
      .where(stillQueued);
  }
}

const museReady = (deps: RunDeps) =>
  Boolean((deps.runOptions?.model ?? env.META_MODEL) && env.META_API_KEY);

/** How often graded candidates' listings are refreshed for change warnings. */
export const METADATA_REFRESH_MS = 6 * 3_600_000;

/**
 * Metadata only: refreshes the last-push times of a few graded candidates whose listing is older
 * than METADATA_REFRESH_MS, so change warnings appear without a regrade. Never downloads code or
 * starts grading; stops at a quota response.
 */
export async function refreshMetadata(deps: RunDeps = {}, limit = 5): Promise<number> {
  if (!deps.octokit) return 0;
  try {
    assertGitHubAvailable();
  } catch {
    return 0;
  }
  const due = await db
    .select({ key: demoCandidates.key, login: demoCandidates.githubLogin })
    .from(demoCandidates)
    .where(
      and(
        deps.scope ? like(demoCandidates.key, `${deps.scope}%`) : undefined,
        eq(demoCandidates.organization, false),
        eq(demoCandidates.runStatus, 'idle'),
        sql`${demoCandidates.selectionCheckedAt} is not null`,
        or(
          sql`${demoCandidates.metadataRefreshedAt} is null`,
          lt(demoCandidates.metadataRefreshedAt, new Date(Date.now() - METADATA_REFRESH_MS)),
        ),
      ),
    )
    .orderBy(sql`${demoCandidates.metadataRefreshedAt} asc nulls first`)
    .limit(limit);
  const octokit = (deps.octokit ?? demoOctokit)();
  let refreshed = 0;
  for (const c of due) {
    try {
      await refreshPushedAt(demoSubject(c.key), await listPublicRepos(octokit, c.login));
      refreshed++;
    } catch (err) {
      if (quotaWait(err)) break;
      deps.onError?.(err);
    }
    // Also after another failure, so one broken account is not listed again every tick.
    await db
      .update(demoCandidates)
      .set({ metadataRefreshedAt: new Date() })
      .where(eq(demoCandidates.key, c.key));
  }
  return refreshed;
}

/** One worker step: queue ungraded subjects, then grade the oldest queued one. */
export async function analysisTick(deps: RunDeps = {}): Promise<boolean> {
  if (!museReady(deps)) return false;
  await enqueueUngraded(deps);
  const next = await nextQueued(deps, new Set());
  if (next) await runQueued(next, deps);
  return next !== null;
}

/**
 * Subjects graded at once. A full candidate request reserves up to 1.03M of the 3M tokens a
 * minute, so about three fit; the shared Muse limiter queues anything beyond, and the GitHub pacer
 * spaces repository fetches, so more slots would only wait.
 */
export const WORKER_CONCURRENCY = 3;

/**
 * Grades queued subjects, up to `concurrency` at once, until none is left. A free slot takes the
 * next subject immediately. Picks are serialized, so two slots never start the same subject.
 */
export async function drainQueue(
  deps: RunDeps = {},
  concurrency = WORKER_CONCURRENCY,
): Promise<number> {
  if (!museReady(deps)) return 0;
  await refreshMetadata(deps).catch((err: unknown) => deps.onError?.(err));
  await enqueueUngraded(deps);
  // Keys stay listed after their run, so a subject queued again mid-drain waits for the next one.
  const active = new Set<string>();
  let picking: Promise<unknown> = Promise.resolve();
  let graded = 0;
  const slot = async () => {
    for (;;) {
      const pick = picking.then(async () => {
        const next = await nextQueued(deps, active);
        if (next) active.add(next.key);
        return next;
      });
      picking = pick.catch(() => {});
      const next = await pick;
      if (!next) return;
      await runQueued(next, deps);
      graded++;
    }
  };
  await Promise.all(Array.from({ length: concurrency }, slot));
  return graded;
}

/** Starts the in-process worker; returns a function that stops it. */
export function startAnalysisWorker(deps: RunDeps = {}): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void drainQueue(deps)
      .catch((err: unknown) => deps.onError?.(err))
      .finally(() => (busy = false));
  }, WORKER_INTERVAL_MS);
  return () => clearInterval(timer);
}
