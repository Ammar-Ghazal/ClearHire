// Starts demo analyses. A run is claimed before the caller hears 202; every later write is
// conditional on that run's token, so a stale worker can neither overwrite a newer run nor start a
// paid request. Repository code is fetched per run and only held in memory. Assessment locks,
// caching and spend caps stay in analyzeCandidate/analyzeJob. The worker grades each subject that
// has no result yet, a few at a time; failures are never retried automatically.
import type { Octokit } from '@octokit/rest';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, like, lt, ne, notInArray, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { demoCandidates, demoJobs, skillAssessments } from '../db/schema.js';
import { env } from '../env.js';
import {
  analyzeCandidate,
  analyzeJob,
  HEARTBEAT_MS,
  recoverStaleAssessments,
  type RunOptions,
} from './assessments.js';
import { EvidenceInputError } from './candidate-evidence.js';
import {
  demoOctokit,
  PreparationError,
  prepareDemoCandidate,
  RUN_STALE_MS,
} from './demo-prepare.js';
import { candidateInput, candidateState, jobInput, jobState } from './demo-results.js';
import { IngestError } from './ingest.js';
import { MuseError } from './muse.js';

/** A refusal the route reports as 404 or 409 with this code. */
export class RunError extends Error {
  readonly statusCode: number;
  constructor(
    readonly code:
      | 'not_found'
      | 'no_selected_repositories'
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
}

export interface Started {
  result: 'started' | 'cached';
  /** Settles when the worker finishes; never rejects. Undefined when cached. */
  done?: Promise<void>;
}

type Table = typeof demoCandidates | typeof demoJobs;
const keyColumn = (table: Table) => (table === demoCandidates ? demoCandidates.key : demoJobs.id);

/** Safe, fixed error codes only: exception messages never reach stored state or clients. */
export function safeErrorCode(err: unknown): string {
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

/** Runs `work` while owning the run; heartbeats, then records success or a safe failure code. */
function runOwned(
  table: Table,
  key: string,
  token: string,
  deps: RunDeps,
  work: (owned: () => Promise<boolean>) => Promise<void>,
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
  const finish = (fields: { runStatus: 'idle' | 'failed'; runError: string | null }) =>
    db.update(table).set(fields).where(owner);
  return (async () => {
    try {
      await work(touch);
      await finish({ runStatus: 'idle', runError: null });
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
}

// ---- Candidates ----

export async function startCandidateRun(
  key: string,
  { retry, fresh = false }: StartOptions,
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
  if (row.repositories.length === 0) {
    throw new RunError('no_selected_repositories', 'This profile has no selected repositories');
  }
  requireModel(deps);
  await recoverStaleAssessments({ kind: 'candidate', subjectKind: 'demo', subjectKey: key });
  await recoverRun(demoCandidates, key);
  if (!fresh && (await candidateState(row, deps.runOptions)).freshness.state === 'current') {
    return { result: 'cached' };
  }

  const token = await claimRun(demoCandidates, key, retry || fresh);
  const done = runOwned(demoCandidates, key, token, deps, async (owned) => {
    const [current] = await db.select().from(demoCandidates).where(eq(demoCandidates.key, key));
    if (!current) throw new RunError('not_found', 'No demo candidate with this key');
    // Held only in memory for this run; never written anywhere.
    const prepared = await prepareDemoCandidate(
      (deps.octokit ?? demoOctokit)(),
      candidateInput(current),
    );
    // A worker whose claim was recovered or superseded must not start a paid request.
    if (!(await owned())) throw new OwnershipLost();
    await analyzeCandidate(prepared, { ...deps.runOptions, retryFailed: retry || fresh, fresh });
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
  if (!deps.octokit && !env.GITHUB_DEMO_TOKEN) return;
  // Legacy results have no manifest, so those candidates are graded live once.
  await db
    .update(demoCandidates)
    .set(queued)
    .where(
      and(
        inScope(demoCandidates),
        eq(demoCandidates.organization, false),
        eq(demoCandidates.runStatus, 'idle'),
        sql`jsonb_array_length(${demoCandidates.repositories}) > 0`,
        sql`not exists (select 1 from ${skillAssessments} where ${skillAssessments.kind} = 'candidate'
          and ${skillAssessments.subjectKind} = 'demo' and ${skillAssessments.subjectKey} = ${demoCandidates.key}
          and ${skillAssessments.status} in ${SAVED_STATUSES}
          and ${skillAssessments.inputManifest} is not null)`,
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
          start: () => startCandidateRun(candidate.key, { retry: false }, deps),
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
