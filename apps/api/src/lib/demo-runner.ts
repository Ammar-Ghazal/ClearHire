// Starts demo analyses. A run is claimed before the caller hears 202; every later write is
// conditional on that run's token, so a stale worker can neither overwrite a newer run nor start a
// paid request. Assessment locks, caching and spend caps stay in analyzeCandidate/analyzeJob.
import type { Octokit } from '@octokit/rest';
import { randomUUID } from 'node:crypto';
import { and, eq, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { demoCandidates, demoJobs } from '../db/schema.js';
import { env } from '../env.js';
import {
  analyzeCandidate,
  analyzeJob,
  HEARTBEAT_MS,
  recoverStaleAssessments,
  type RunOptions,
} from './assessments.js';
import { EvidenceInputError, serializePreparedCandidate } from './candidate-evidence.js';
import {
  demoOctokit,
  effectiveInput,
  PreparationError,
  prepareDemoCandidate,
  RUN_STALE_MS,
  transientRepos,
} from './demo-prepare.js';
import {
  candidateInput,
  candidateState,
  jobInput,
  jobState,
  storedPrepared,
} from './demo-results.js';
import { IngestError } from './ingest.js';
import { MuseError } from './muse.js';
import { sha256Hex } from './packets.js';

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
      | 'previous_failure'
      | 'preparation_incomplete',
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
  if (err instanceof EvidenceInputError) return 'invalid_prepared_data';
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
  const claimable = retry
    ? or(eq(table.runStatus, 'idle'), eq(table.runStatus, 'failed'))
    : eq(table.runStatus, 'idle');
  const claimed = await db
    .update(table)
    .set({ runStatus: 'pending', runId: token, runError: null, runHeartbeatAt: new Date() })
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

// ---- Candidates ----

export async function startCandidateRun(
  key: string,
  { retry }: { retry: boolean },
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

  const state = await candidateState(row, deps.runOptions);
  const ready = state.input?.kind === 'ready' ? state.input.prepared : null;
  const refetch = retry && ready !== null && transientRepos(ready).length > 0;
  if (state.freshness.state === 'current' && !refetch) return { result: 'cached' };

  const token = await claimRun(demoCandidates, key, retry);
  const done = runOwned(demoCandidates, key, token, deps, async (owned) => {
    const [fresh] = await db.select().from(demoCandidates).where(eq(demoCandidates.key, key));
    if (!fresh) throw new RunError('not_found', 'No demo candidate with this key');
    const candidate = candidateInput(fresh);
    const existing = storedPrepared(fresh);
    let current = effectiveInput(candidate, existing);
    const transient =
      retry && current.kind === 'ready' && transientRepos(current.prepared).length > 0;
    if (current.kind !== 'ready' || transient) {
      const prepared = await prepareDemoCandidate(
        (deps.octokit ?? demoOctokit)(),
        candidate,
        existing,
        { refetchTransient: retry },
      );
      const serialized = serializePreparedCandidate(prepared);
      const stored = await db
        .update(demoCandidates)
        .set({ prepared: JSON.parse(serialized), preparedSha256: sha256Hex(serialized) })
        .where(and(eq(demoCandidates.key, key), eq(demoCandidates.runId, token)))
        .returning({ key: demoCandidates.key });
      if (stored.length === 0) throw new OwnershipLost();
      current = effectiveInput(candidate, prepared);
      if (current.kind !== 'ready') {
        throw new RunError('preparation_incomplete', 'Preparation is incomplete');
      }
    }
    // A worker whose claim was recovered or superseded must not start a paid request.
    if (!(await owned())) throw new OwnershipLost();
    await analyzeCandidate(current.prepared, { ...deps.runOptions, retryFailed: retry });
  });
  return { result: 'started', done };
}

// ---- Jobs ----

export async function startJobRun(
  id: string,
  { retry }: { retry: boolean },
  deps: RunDeps = {},
): Promise<Started> {
  const [row] = await db.select().from(demoJobs).where(eq(demoJobs.id, id));
  if (!row) throw new RunError('not_found', 'No demo job with this id');
  if (!row.inScope) throw new RunError('out_of_scope', 'Out-of-scope postings are not analysed');
  requireModel(deps);
  await recoverStaleAssessments({ kind: 'job', subjectKind: 'demo', subjectKey: id });
  await recoverRun(demoJobs, id);

  if ((await jobState(row, deps.runOptions)).freshness.state === 'current') {
    return { result: 'cached' };
  }

  const token = await claimRun(demoJobs, id, retry);
  const done = runOwned(demoJobs, id, token, deps, async (owned) => {
    const [fresh] = await db.select().from(demoJobs).where(eq(demoJobs.id, id));
    if (!fresh) throw new RunError('not_found', 'No demo job with this id');
    if (!(await owned())) throw new OwnershipLost();
    await analyzeJob(
      { ...jobInput(fresh), dataUse: 'approved_public_demo' },
      { ...deps.runOptions, retryFailed: retry },
    );
  });
  return { result: 'started', done };
}
