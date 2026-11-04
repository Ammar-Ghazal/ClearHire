// Runs and stores candidate and job assessments. Every run is its own row; a pending row per subject
// is the lock that stops duplicate paid calls, and saved rows for the same code-free input key act as
// the cache unless a run is explicitly fresh. Only results and metadata are stored, never repository
// code. Spend is reserved atomically across scopes before every attempt and settled conservatively.
import {
  CandidateAssessmentSchema,
  JobAssessmentSchema,
  PriorityOverrideSchema,
  SKILL_CATALOGUE,
  type CandidateAssessment,
  type JobAssessment,
  type MatchResult,
  type PriorityOverride,
} from '@clearhire/shared';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  jobPriorityOverrides,
  museCalls,
  museSpendBudgets,
  repositorySelections,
  skillAssessments,
  type InputManifest,
} from '../db/schema.js';
import { env } from '../env.js';
import {
  isIncomplete,
  scrubQuotedSource,
  verifyCandidate,
  verifyJob,
  verifyReassessment,
  VERIFIER_VERSION,
  type JobInput,
} from './assessment-verify.js';
import { ATTRIBUTION_VERSION } from './attribution.js';
import {
  buildCandidateEvidence,
  renderEvidence,
  SELECTION_VERSION,
  type CandidateEvidence,
  type DataUse,
  type Omission,
  type PreparedCandidate,
  type PreparedRepo,
} from './candidate-evidence.js';
import {
  applyOverlays,
  combineParts,
  legacyView,
  prefixRefs,
  type Overlay,
} from './candidate-combine.js';
import { mergeAssessments, packParts } from './candidate-parts.js';
import { matchAssessments } from './matching.js';
import {
  assertDataUse,
  callMuse,
  CandidateOutputSchema,
  candidateBody,
  CANDIDATE_MAX_COMPLETION_TOKENS,
  canonicalJson,
  catalogueHash,
  CONTEXT_WINDOW,
  countTokens,
  DEFAULT_INPUT_TOKEN_CEILING,
  estimateTokens,
  jobBody,
  JobOutputSchema,
  JOB_MAX_COMPLETION_TOKENS,
  MuseError,
  reassessmentBody,
  ReassessmentOutputSchema,
  PROMPT_VERSION,
  SCHEMA_VERSION,
  type AttemptSettlement,
  type CandidateOutput,
  type ChatBody,
  type CountOutcome,
  type MuseLedger,
  type MuseModel,
  type RateLimiter,
  type ReassessmentOutput,
} from './muse.js';
import { CLEANER_VERSION, sha256Hex } from './packets.js';

export const CANDIDATE_TIMEOUT_MS = 600_000;
export const JOB_TIMEOUT_MS = 120_000;
export const HEARTBEAT_MS = 30_000;
/** A pending row is stale only when its runner has not refreshed it for this long. */
export const staleAfterMs = (kind: 'candidate' | 'job' | 'repository') =>
  (kind === 'job' ? JOB_TIMEOUT_MS : CANDIDATE_TIMEOUT_MS) + 120_000;

const SAVED = ['complete', 'partial', 'no_attributed_evidence'] as const;
type Saved = (typeof SAVED)[number];
type Row = typeof skillAssessments.$inferSelect;
const usd = (dollars: number) => Math.round(dollars * 1_000_000);

/** Lifetime analysis spend per candidate, demo seeker or user, across all repositories and runs. */
export const CANDIDATE_SPEND_CAP_USD = 15;

export interface PreparedJob extends JobInput {
  dataUse: DataUse;
}

export interface RunOptions {
  model?: MuseModel;
  inputTokenCeiling?: number;
  /** Re-runs a failed assessment; failures are never resent automatically. */
  retryFailed?: boolean;
  /** Explicit regrade: always a new assessment, never a saved result for the same input. */
  fresh?: boolean;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  limiter?: RateLimiter;
  /** Told each token count's outcome, failure category and timing; never request contents. */
  onCount?: (outcome: CountOutcome) => void;
  timeoutMs?: number;
  /** Prefix for budget scopes, so tests never touch the real daily budget. */
  budgetNamespace?: string;
}

export interface RunResult<T> {
  assessmentId: string;
  assessment: T;
  cached: boolean;
}

function selectedModel(options: RunOptions): MuseModel {
  const model = options.model ?? env.META_MODEL;
  if (!model) throw new MuseError('not_configured', 'META_MODEL is not set');
  return model;
}

function museConfig() {
  if (!env.META_API_KEY) throw new MuseError('not_configured', 'META_API_KEY is not set');
  return { apiKey: env.META_API_KEY, baseUrl: env.META_BASE_URL };
}

const VERSIONS = () => ({
  catalogue: catalogueHash(),
  prompt: PROMPT_VERSION,
  schema: SCHEMA_VERSION,
  cleaner: CLEANER_VERSION,
  selection: SELECTION_VERSION,
  attribution: ATTRIBUTION_VERSION,
});

/** Content address: the exact request (model included), the stored evidence and every version. */
export const cacheKeyOf = (parts: Record<string, unknown>) =>
  sha256Hex(canonicalJson({ ...parts, versions: VERSIONS() }));

// ---- Spend ledger ----

export function scopesFor(
  kind: 'candidate' | 'job',
  subject: { kind: string; key: string },
  ns = '',
) {
  const own = `${ns}subject:${kind}:${subject.kind}:${subject.key}`;
  // A candidate spends only their own allowance; the shared daily cap must not block it.
  if (kind === 'candidate') return [{ scope: own, cap: usd(CANDIDATE_SPEND_CAP_USD) }];
  const day = new Date().toISOString().slice(0, 10);
  return [
    { scope: `${ns}daily:${day}`, cap: usd(env.META_DAILY_CAP_USD) },
    { scope: own, cap: usd(env.META_SUBJECT_CAP_USD) },
  ].sort((a, b) => (a.scope < b.scope ? -1 : 1));
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Call = typeof museCalls.$inferSelect;

/** Settles one locked, still-reserved call inside the caller's transaction. */
async function settleLocked(tx: Tx, call: Call, s: AttemptSettlement): Promise<void> {
  const budgetCharge = s.waiveBudgetCharge ? 0 : s.costMicroUsd;
  for (const scope of [...call.scopes].sort()) {
    await tx
      .update(museSpendBudgets)
      .set({
        reservedMicroUsd: sql`${museSpendBudgets.reservedMicroUsd} - ${call.reservedMicroUsd}`,
        spentMicroUsd: sql`${museSpendBudgets.spentMicroUsd} + ${budgetCharge}`,
        updatedAt: new Date(),
      })
      .where(eq(museSpendBudgets.scope, scope));
  }
  await tx
    .update(museCalls)
    .set({
      settlement: s.settlement,
      costSource: s.costSource,
      costMicroUsd: s.costMicroUsd,
      httpStatus: s.httpStatus,
      finishReason: s.finishReason,
      promptTokens: s.usage?.promptTokens ?? null,
      cachedTokens: s.usage?.cachedTokens ?? null,
      completionTokens: s.usage?.completionTokens ?? null,
      reasoningTokens: s.usage?.reasoningTokens ?? null,
      latencyMs: s.latencyMs,
      responseId: s.responseId,
      errorCode: s.errorCode,
      settledAt: new Date(),
    })
    .where(eq(museCalls.id, call.id));
}

async function settleCall(callId: string, s: AttemptSettlement): Promise<void> {
  await db.transaction(async (tx) => {
    const [call] = await tx
      .select()
      .from(museCalls)
      .where(and(eq(museCalls.id, callId), eq(museCalls.settlement, 'reserved')))
      .for('update');
    if (call) await settleLocked(tx, call, s);
  });
}

/** A run is identified by its row and `startedAt`, which every claim or reclaim resets. */
const currentRun = (id: string, run: Date) =>
  and(
    eq(skillAssessments.id, id),
    eq(skillAssessments.status, 'pending'),
    eq(skillAssessments.startedAt, run),
  );

/** Reserves every scope in one transaction; any exhausted cap rolls back the whole reservation. */
export function dbLedger(
  assessmentId: string,
  model: MuseModel,
  scopes: { scope: string; cap: number }[],
  run: Date,
): MuseLedger {
  return {
    reserve: (attempt, reserved) =>
      db.transaction(async (tx) => {
        // Waits for any recovery holding the row. Only the current run may reserve: a recovered
        // run, or an old runner whose row a retry reclaimed, cannot.
        const [running] = await tx
          .select({ id: skillAssessments.id })
          .from(skillAssessments)
          .where(currentRun(assessmentId, run))
          .for('share');
        if (!running) {
          throw new MuseError('previous_failure', 'This assessment run is no longer active');
        }
        for (const { scope, cap } of scopes) {
          await tx
            .insert(museSpendBudgets)
            .values({ scope, capMicroUsd: cap })
            .onConflictDoUpdate({ target: museSpendBudgets.scope, set: { capMicroUsd: cap } });
          const ok = await tx
            .update(museSpendBudgets)
            .set({
              reservedMicroUsd: sql`${museSpendBudgets.reservedMicroUsd} + ${reserved}`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(museSpendBudgets.scope, scope),
                sql`${museSpendBudgets.reservedMicroUsd} + ${museSpendBudgets.spentMicroUsd} + ${reserved}
                  <= ${museSpendBudgets.capMicroUsd}`,
              ),
            )
            .returning({ scope: museSpendBudgets.scope });
          if (ok.length === 0)
            throw new MuseError('budget_exceeded', `Spending cap reached for ${scope}`);
        }
        const [call] = await tx
          .insert(museCalls)
          .values({
            assessmentId,
            model,
            attempt,
            scopes: scopes.map((s) => s.scope),
            settlement: 'reserved',
            reservedMicroUsd: reserved,
          })
          .returning({ id: museCalls.id });
        return call!.id;
      }),
    settle: settleCall,
  };
}

// ---- Claims, recovery and caching ----

/**
 * Atomically marks a stale pending row failed and moves its open reservations to estimated spend.
 * The row lock makes concurrent retries and reservations wait, so this recovery can only settle
 * reservations made by the interrupted run, and a crash leaves either everything or nothing done.
 */
async function failStale(rowId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(skillAssessments)
      .where(and(eq(skillAssessments.id, rowId), eq(skillAssessments.status, 'pending')))
      .for('update');
    if (!row || row.heartbeatAt.getTime() >= Date.now() - staleAfterMs(row.kind)) return false;
    await tx
      .update(skillAssessments)
      .set({ status: 'failed', errorCode: 'interrupted', completedAt: new Date() })
      .where(eq(skillAssessments.id, row.id));
    const open = await tx
      .select()
      .from(museCalls)
      .where(and(eq(museCalls.assessmentId, row.id), eq(museCalls.settlement, 'reserved')))
      .for('update');
    for (const call of open) {
      await settleLocked(tx, call, {
        settlement: 'ambiguous',
        costMicroUsd: call.reservedMicroUsd,
        costSource: 'reservation',
        httpStatus: null,
        finishReason: null,
        usage: null,
        latencyMs: 0,
        responseId: null,
        errorCode: 'timeout',
      });
    }
    return true;
  });
}

/** Recovers stale pending assessments (all, or one subject's); never resends their requests. */
export async function recoverStaleAssessments(subject?: {
  kind: 'candidate' | 'job' | 'repository';
  subjectKind: 'demo' | 'user';
  subjectKey: string;
}): Promise<number> {
  const pending = await db
    .select()
    .from(skillAssessments)
    .where(
      and(
        eq(skillAssessments.status, 'pending'),
        subject &&
          and(
            eq(skillAssessments.kind, subject.kind),
            eq(skillAssessments.subjectKind, subject.subjectKind),
            eq(skillAssessments.subjectKey, subject.subjectKey),
          ),
      ),
    );
  let recovered = 0;
  const errors: unknown[] = [];
  for (const row of pending) {
    try {
      if (await failStale(row.id)) recovered++;
    } catch (err) {
      errors.push(err);
    }
  }
  if (errors.length > 0) throw errors[0];
  return recovered;
}

type Claim = { kind: 'fresh'; row: Row } | { kind: 'saved'; row: Row };

const sameSubject = (values: typeof skillAssessments.$inferInsert) =>
  and(
    eq(skillAssessments.kind, values.kind),
    eq(skillAssessments.subjectKind, values.subjectKind),
    eq(skillAssessments.subjectKey, values.subjectKey),
  );

async function claim(
  values: typeof skillAssessments.$inferInsert,
  { retryFailed, fresh }: { retryFailed: boolean; fresh: boolean },
): Promise<Claim> {
  if (!fresh) {
    const [saved] = await db
      .select()
      .from(skillAssessments)
      .where(
        and(
          sameSubject(values),
          eq(skillAssessments.cacheKey, values.cacheKey),
          inArray(skillAssessments.status, [...SAVED]),
        ),
      )
      .orderBy(desc(skillAssessments.completedAt))
      .limit(1);
    if (saved) return { kind: 'saved', row: saved };
    const [latest] = await db
      .select({ status: skillAssessments.status, errorCode: skillAssessments.errorCode })
      .from(skillAssessments)
      .where(and(sameSubject(values), eq(skillAssessments.cacheKey, values.cacheKey)))
      .orderBy(desc(skillAssessments.startedAt))
      .limit(1);
    if (latest?.status === 'failed' && !retryFailed) {
      throw new MuseError(
        'previous_failure',
        `A previous run failed (${latest.errorCode ?? 'unknown'})`,
      );
    }
  }
  // Millisecond timestamps, so `startedAt` round-trips exactly as the run token.
  const now = new Date();
  const [inserted] = await db
    .insert(skillAssessments)
    .values({ ...values, startedAt: now, heartbeatAt: now })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { kind: 'fresh', row: inserted };
  // The subject's single-flight index is held by another run.
  const [running] = await db
    .select({ id: skillAssessments.id })
    .from(skillAssessments)
    .where(and(sameSubject(values), eq(skillAssessments.status, 'pending')));
  if (running && (await failStale(running.id))) {
    throw new MuseError('previous_failure', 'A previous run was interrupted; retry explicitly');
  }
  throw new MuseError('in_progress', 'An assessment of this subject is already running');
}

/** Saves a result; with `run`, only while that run still owns the row. Returns false otherwise. */
async function complete(
  id: string,
  status: Saved,
  fields: Partial<typeof skillAssessments.$inferInsert>,
  run?: Date,
): Promise<boolean> {
  const updated = await db
    .update(skillAssessments)
    .set({
      ...fields,
      status,
      errorCode: null,
      verifierVersion: VERIFIER_VERSION,
      completedAt: new Date(),
    })
    .where(run ? currentRun(id, run) : eq(skillAssessments.id, id))
    .returning({ id: skillAssessments.id });
  return updated.length > 0;
}

async function fail(id: string, run: Date, err: unknown) {
  const code = err instanceof MuseError ? err.code : 'internal_error';
  await db
    .update(skillAssessments)
    .set({ status: 'failed', errorCode: code, completedAt: new Date() })
    .where(currentRun(id, run));
}

/**
 * Runs the paid calls for a freshly claimed row in order, keeping its heartbeat alive meanwhile.
 * When a later call fails, the outputs so far are verified and saved, and `verify` reports what
 * was not processed; a superseded run, or a failure before any output, saves nothing.
 */
async function runClaimed<O, A>(
  row: Row,
  options: RunOptions,
  call: {
    requests: { body: ChatBody; inputTokens?: number }[];
    schema: typeof CandidateOutputSchema | typeof JobOutputSchema;
    timeoutMs: number;
  },
  scopes: { scope: string; cap: number }[],
  verify: (outputs: O[]) => A & { status?: string },
  fields:
    | Partial<typeof skillAssessments.$inferInsert>
    | ((assessment: A) => Partial<typeof skillAssessments.$inferInsert>) = {},
): Promise<A> {
  const heartbeat = setInterval(() => {
    void db
      .update(skillAssessments)
      .set({ heartbeatAt: new Date() })
      .where(currentRun(row.id, row.startedAt))
      .catch(() => {});
  }, HEARTBEAT_MS);
  try {
    const outputs: O[] = [];
    for (const { body, inputTokens } of call.requests) {
      try {
        const result = await callMuse({
          config: museConfig(),
          body,
          schema: call.schema as never,
          timeoutMs: options.timeoutMs ?? call.timeoutMs,
          ledger: dbLedger(row.id, body.model, scopes, row.startedAt),
          ...(inputTokens !== undefined && { inputTokens }),
          ...(options.limiter && { limiter: options.limiter }),
          ...(options.fetch && { fetch: options.fetch }),
          ...(options.sleep && { sleep: options.sleep }),
        });
        outputs.push(result.data as O);
      } catch (err) {
        const superseded = err instanceof MuseError && err.code === 'previous_failure';
        if (outputs.length === 0 || superseded || !(err instanceof MuseError)) throw err;
        break;
      }
    }
    const assessment = verify(outputs);
    const status = (assessment.status === 'partial' ? 'partial' : 'complete') as Saved;
    const extra = typeof fields === 'function' ? fields(assessment) : fields;
    const saved = await complete(row.id, status, { ...extra, result: assessment }, row.startedAt);
    if (!saved)
      throw new MuseError('previous_failure', 'This run was superseded; its result was discarded');
    return assessment;
  } catch (err) {
    await fail(row.id, row.startedAt, err);
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
}

// ---- Candidates ----

interface CandidateRequest {
  body: ChatBody;
  inputTokens: number;
  /** Files this request holds; null when it holds all of them. */
  keys: ReadonlySet<string> | null;
}

/** Request headroom under the ceiling when packing by estimate; each part is then counted. */
const PACKING_HEADROOM = 0.97;

/**
 * Plans the requests for the prepared repositories and the resume, each counted on its whole body:
 * catalogue, rules, schema, resume, dependencies and code. Everything goes in one request when it
 * fits under the ceiling; otherwise the evidence is split across requests (see packParts), so no
 * code is truncated or dropped. With `scope.primary`, only those files are packed for their own
 * sake. Every request is counted: no character estimate ever authorizes one.
 */
async function planCandidate(
  prepared: PreparedCandidate,
  model: MuseModel,
  ceiling: number,
  options: RunOptions,
  /** Data-use check that must pass before a count sends anything to Muse. */
  beforeSend: () => void,
  scope?: { evidence: CandidateEvidence; primary: ReadonlySet<string> },
): Promise<{ evidence: CandidateEvidence; requests: CandidateRequest[] }> {
  const resume = prepared.resume?.text ?? null;
  const fixed = estimateTokens(candidateBody(model, '', resume));
  if (fixed >= ceiling)
    throw new MuseError('input_too_large', 'Catalogue, rules and resume exceed the ceiling');
  const evidence =
    scope?.evidence ?? buildCandidateEvidence(prepared, { evidenceChars: Number.MAX_SAFE_INTEGER });
  const whole = candidateBody(model, evidence.rendered, resume);
  const estimate = estimateTokens(whole);
  // Nothing is sent without evidence.
  if (evidence.citableCount === 0) {
    return { evidence, requests: [{ body: whole, inputTokens: estimate, keys: null }] };
  }
  beforeSend();
  const count = (body: ChatBody) =>
    countTokens(museConfig(), body, {
      ...(options.fetch && { fetch: options.fetch }),
      ...(options.sleep && { sleep: options.sleep }),
      ...(options.onCount && { onCount: options.onCount }),
    });
  const counted = await count(whole);
  if (counted <= ceiling) {
    return { evidence, requests: [{ body: whole, inputTokens: counted, keys: null }] };
  }

  // Pack by estimate scaled to the counted size, then count each request; halve any still over.
  const ratio = counted / estimate;
  const tokens = (text: string) => Math.ceil((JSON.stringify(text).length / 3) * ratio);
  const budget = Math.floor(ceiling * PACKING_HEADROOM) - Math.ceil(fixed * ratio);
  const partBody = (keys: ReadonlySet<string>, index: number, total: number) =>
    candidateBody(
      model,
      `Request ${index + 1} of ${total} for this candidate: it holds some of the selected ` +
        `repositories' files, and the others are assessed in separate requests. Assess only what ` +
        `this request shows.\n${renderEvidence(evidence.layout, keys, index === 0)}`,
      resume,
    );
  const pending = packParts(evidence.layout, tokens, budget, scope?.primary);
  const checked: { keys: Set<string>; inputTokens: number }[] = [];
  while (pending.length > 0) {
    const keys = pending.shift()!;
    const inputTokens = await count(partBody(keys, checked.length, checked.length + 1));
    if (inputTokens <= ceiling) {
      checked.push({ keys, inputTokens });
    } else if (keys.size > 1) {
      const list = [...keys];
      const half = Math.ceil(list.length / 2);
      pending.unshift(new Set(list.slice(0, half)), new Set(list.slice(half)));
    } else {
      throw new MuseError('input_too_large', 'A single file exceeds the input ceiling');
    }
  }
  // The request number was counted with fewer digits at most; a few tokens cover the difference.
  return {
    evidence,
    requests: checked.map(({ keys, inputTokens }, i) => ({
      body: partBody(keys, i, checked.length),
      inputTokens: inputTokens + 8,
      keys,
    })),
  };
}

/**
 * Verifies each request's output against only the evidence it sent, then consolidates them. Files
 * of requests that never completed are reported as not processed, which makes coverage partial.
 */
function verifyRequests(
  outputs: CandidateOutput[],
  requests: CandidateRequest[],
  evidence: CandidateEvidence,
  meta: { subject: PreparedCandidate['subject']; model: MuseModel },
  /** File keys whose evidence a request may cite; others were sent only as context. */
  citable?: ReadonlySet<string>,
): CandidateAssessment {
  const files = new Map(evidence.layout.repos.flatMap((r) => r.files.map((f) => [f.key, f])));
  const processed = new Set(requests.slice(0, outputs.length).flatMap((r) => [...(r.keys ?? [])]));
  const unprocessed = new Set(
    requests
      .slice(outputs.length)
      .flatMap((r) => [...(r.keys ?? [])])
      .filter((k) => !processed.has(k)),
  );
  const coverage =
    unprocessed.size === 0
      ? evidence.coverage
      : {
          ...evidence.coverage,
          evidence: 'sampled' as const,
          omissions: [
            ...evidence.coverage.omissions,
            ...[...unprocessed].map((key) => {
              const [repoIndex, path] = key.split('\0') as [string, string];
              return {
                repo: evidence.repos[Number(repoIndex)]!.repo,
                path,
                reason: 'not_processed' as const,
                startLine: null,
                endLine: null,
              };
            }),
          ],
        };
  const all = { ...evidence, coverage };
  const verified = outputs.map((output, i) => {
    const keys = requests[i]!.keys ?? (citable ? new Set(files.keys()) : null);
    if (keys === null) return verifyCandidate(output, all, meta);
    const own = [...keys].filter((k) => !citable || citable.has(k));
    const refs = new Set(own.flatMap((k) => files.get(k)!.refs));
    const items = all.items.filter((it) => refs.has(it.ref));
    return verifyCandidate(output, { ...all, items }, meta);
  });
  return scrubQuotedSource(
    verified.length === 1
      ? verified[0]!
      : mergeAssessments(verified, coverage, isIncomplete(coverage) ? 'partial' : 'complete'),
    evidence,
  );
}

/**
 * The code-free input key: the subject, model, selected repositories, résumé and every version.
 * Reads compute it from stored metadata; runs from what they fetched, so both always agree.
 */
export function candidateKey(
  subject: PreparedCandidate['subject'],
  input: { repos: { owner: string; repo: string }[]; resumeText: string | null },
  options: RunOptions = {},
) {
  const model = selectedModel(options);
  const repos = [...new Set(input.repos.map((r) => `${r.owner}/${r.repo}`.toLowerCase()))].sort();
  const resumeSha256 = input.resumeText === null ? null : sha256Hex(input.resumeText);
  return { model, cacheKey: cacheKeyOf({ kind: 'candidate', subject, model, repos, resumeSha256 }) };
}

/** The commits and availability a run graded; never any file content. */
function manifestOf(prepared: PreparedCandidate): InputManifest {
  return {
    repos: prepared.repos.map((r) =>
      'unavailable' in r
        ? { repo: `${r.owner}/${r.repo}`, commitSha: null, unavailable: r.unavailable }
        : { repo: `${r.owner}/${r.repo}`, commitSha: r.snapshot.commitSha, unavailable: null },
    ),
    resumeSha256: prepared.resume ? sha256Hex(prepared.resume.text) : null,
  };
}

export async function analyzeCandidate(
  prepared: PreparedCandidate,
  options: RunOptions = {},
): Promise<RunResult<CandidateAssessment>> {
  const model = selectedModel(options);
  assertDataUse(model, [prepared.dataUse]);
  const ceiling = options.inputTokenCeiling ?? DEFAULT_INPUT_TOKEN_CEILING;
  if (ceiling + CANDIDATE_MAX_COMPLETION_TOKENS > CONTEXT_WINDOW) {
    throw new MuseError(
      'input_too_large',
      'Input ceiling leaves no room for output in the context window',
    );
  }
  // Résumé text is restricted data, except demo résumés: the project owner approved sending those
  // to Contributor mode, including its training use. Checked before claim() so a refusal leaves no
  // pending row; the no-evidence branch sends nothing, so it needs no check.
  const assertResume = () => {
    if (!prepared.resume) return;
    assertDataUse(model, [prepared.subject.kind === 'demo' ? 'approved_public_demo' : 'restricted']);
  };
  const { evidence, requests } = await planCandidate(
    prepared,
    model,
    ceiling,
    options,
    assertResume,
  );
  const noEvidence = evidence.citableCount === 0;
  if (!noEvidence) assertResume();
  const { cacheKey } = candidateKey(
    prepared.subject,
    { repos: prepared.repos, resumeText: prepared.resume?.text ?? null },
    { ...options, model },
  );
  const inputManifest = manifestOf(prepared);

  const claimed = await claim(
    {
      kind: 'candidate',
      subjectKind: prepared.subject.kind,
      subjectKey: prepared.subject.key,
      cacheKey,
      model,
      catalogueVersion: SKILL_CATALOGUE.version,
      status: 'pending',
    },
    { retryFailed: options.retryFailed ?? false, fresh: options.fresh ?? false },
  );
  const { row } = claimed;
  if (claimed.kind === 'saved') {
    const assessment = CandidateAssessmentSchema.parse(row.result);
    return { assessmentId: row.id, assessment, cached: true };
  }

  if (noEvidence) {
    const assessment: CandidateAssessment = {
      kind: 'candidate',
      subject: prepared.subject,
      model,
      catalogue: { id: SKILL_CATALOGUE.id, version: SKILL_CATALOGUE.version },
      status: 'no_attributed_evidence',
      verification: 'location_verified_not_competency',
      coverage: evidence.coverage,
      repositories: [],
      skills: [],
      unsupportedSkills: [],
    };
    await complete(
      row.id,
      'no_attributed_evidence',
      { result: assessment, inputManifest },
      row.startedAt,
    );
    return { assessmentId: row.id, assessment, cached: false };
  }

  const assessment = await runClaimed(
    row,
    options,
    { requests, schema: CandidateOutputSchema, timeoutMs: CANDIDATE_TIMEOUT_MS },
    scopesFor('candidate', prepared.subject, options.budgetNamespace),
    (outputs: CandidateOutput[]) =>
      verifyRequests(outputs, requests, evidence, { subject: prepared.subject, model }),
    { inputManifest },
  );
  return { assessmentId: row.id, assessment, cached: false };
}

// ---- Repositories: one saved row per counted request ----

/** Content address of one repository row: the part's identity at one commit, plus every version. */
export const repositoryRowKey = (
  subject: PreparedCandidate['subject'],
  model: MuseModel,
  repoId: number,
  commitSha: string,
  part: string,
) => cacheKeyOf({ kind: 'repository', subject, model, repoId, commitSha, part });

const digest = (paths: string[]) => sha256Hex(paths.join('\n')).slice(0, 16);
const pathOf = (key: string) => key.slice(key.indexOf('\0') + 1);

type Selection = typeof repositorySelections.$inferSelect;

/** The subject's active selection, in the order it was chosen. */
export async function activeSelection(subject: { kind: 'demo' | 'user'; key: string }) {
  return db
    .select()
    .from(repositorySelections)
    .where(
      and(
        eq(repositorySelections.subjectKind, subject.kind),
        eq(repositorySelections.subjectKey, subject.key),
        eq(repositorySelections.active, true),
      ),
    )
    .orderBy(asc(repositorySelections.position));
}

function repositoryValues(
  subject: PreparedCandidate['subject'],
  model: MuseModel,
  repoId: number,
  commitSha: string,
  part: string,
): typeof skillAssessments.$inferInsert {
  return {
    kind: 'repository',
    subjectKind: subject.kind,
    subjectKey: subject.key,
    repoId,
    part,
    cacheKey: repositoryRowKey(subject, model, repoId, commitSha, part),
    model,
    catalogueVersion: SKILL_CATALOGUE.version,
    status: 'pending',
  };
}

const emptyCoverage = (): CandidateAssessment['coverage'] => ({
  evidence: 'complete',
  unavailableRepos: [],
  omissions: [],
  duplicates: [],
  attributionGaps: [],
  limitations: [],
});

/** Saves a no-evidence result for one part without any model call; an earlier save is kept. */
export async function saveNoEvidence(
  input: {
    subject: PreparedCandidate['subject'];
    repoId: number;
    commitSha: string;
    part: string;
    manifest: InputManifest;
    coverage?: CandidateAssessment['coverage'];
    /** A fresh regrade saves anew instead of reusing an earlier save. */
    fresh?: boolean;
  },
  options: RunOptions = {},
): Promise<void> {
  const model = selectedModel(options);
  const claimed = await claim(
    repositoryValues(input.subject, model, input.repoId, input.commitSha, input.part),
    { retryFailed: true, fresh: input.fresh ?? false },
  );
  if (claimed.kind === 'saved') return;
  const assessment: CandidateAssessment = {
    kind: 'candidate',
    subject: input.subject,
    model,
    catalogue: { id: SKILL_CATALOGUE.id, version: SKILL_CATALOGUE.version },
    status: 'no_attributed_evidence',
    verification: 'location_verified_not_competency',
    coverage: input.coverage ?? emptyCoverage(),
    repositories: [],
    skills: [],
    unsupportedSkills: [],
  };
  await complete(
    claimed.row.id,
    'no_attributed_evidence',
    { result: assessment, inputManifest: input.manifest },
    claimed.row.startedAt,
  );
}

export interface RepositoryBatch {
  /** Exactly one available repository: the batch's files plus their context. */
  prepared: PreparedCandidate;
  repoId: number;
  /** `batch:i/n:<digest>` at the prepared commit. */
  part: string;
  /** Paths this batch assesses as its own evidence; any other file is context only. */
  core: ReadonlySet<string>;
  /** Core paths an earlier processed request already covers. */
  processed: ReadonlySet<string>;
  attribution: 'complete' | 'limited';
  /** Automatic runs never resend a request whose earlier attempt failed. */
  automatic: boolean;
  /** A fresh regrade: requests are sent anew even when a same-commit result was saved earlier. */
  fresh: boolean;
  /** Checked before every paid request; false stops the batch (a superseded run). */
  owned?: () => Promise<boolean>;
  /** Context the batch needed but could not send (filtered, too large or over the context cap). */
  omissions?: Omission[];
}

/**
 * Grades the unprocessed core files of one download batch. Each counted request is its own row
 * (`<part>:req:<digest of its core paths>`), so a verified request is never paid for again and a
 * resumed run plans only the files no processed request covers. Returns the core paths processed.
 */
export async function analyzeRepositoryBatch(
  batch: RepositoryBatch,
  options: RunOptions = {},
): Promise<Set<string>> {
  const { prepared } = batch;
  const model = selectedModel(options);
  assertDataUse(model, [prepared.dataUse]);
  const ceiling = options.inputTokenCeiling ?? DEFAULT_INPUT_TOKEN_CEILING;
  if (ceiling + CANDIDATE_MAX_COMPLETION_TOKENS > CONTEXT_WINDOW) {
    throw new MuseError('input_too_large', 'Input ceiling leaves no room for output');
  }
  const repo = prepared.repos[0] as PreparedRepo;
  const name = `${repo.owner}/${repo.repo}`;
  const commitSha = repo.snapshot.commitSha;
  const evidence = buildCandidateEvidence(prepared, { evidenceChars: Number.MAX_SAFE_INTEGER });
  if (batch.omissions?.length) {
    evidence.coverage.omissions.push(...batch.omissions);
    evidence.coverage.evidence = 'sampled';
  }
  const files = evidence.layout.repos.flatMap((r) => r.files);
  const rendered = new Set(files.map((f) => pathOf(f.key)));
  const done = new Set(batch.processed);
  // Core files that render nothing (filtered, empty, summarized) hold nothing to send.
  for (const p of batch.core) if (!rendered.has(p)) done.add(p);
  const primary = new Set(
    files.filter((f) => batch.core.has(pathOf(f.key)) && !done.has(pathOf(f.key))).map((f) => f.key),
  );
  if (primary.size === 0) return done;

  const manifest = (paths: string[]): InputManifest => ({
    repos: [{ repo: name, commitSha, unavailable: null }],
    resumeSha256: prepared.resume ? sha256Hex(prepared.resume.text) : null,
    paths,
    attribution: batch.attribution,
  });
  const kinds = new Map(evidence.items.map((i) => [i.ref, i.kind]));
  const citable = files
    .filter((f) => primary.has(f.key))
    .some((f) => f.refs.some((r) => kinds.get(r) === 'attributed'));
  if (!citable) {
    const paths = [...primary].map(pathOf).sort();
    await saveNoEvidence(
      {
        subject: prepared.subject,
        repoId: batch.repoId,
        commitSha,
        part: `${batch.part}:none:${digest(paths)}`,
        manifest: manifest(paths),
        coverage: evidence.coverage,
        fresh: batch.fresh,
      },
      options,
    );
    for (const p of paths) done.add(p);
    return done;
  }

  const assertResume = () => {
    if (!prepared.resume) return;
    assertDataUse(model, [prepared.subject.kind === 'demo' ? 'approved_public_demo' : 'restricted']);
  };
  assertResume();
  const { requests } = await planCandidate(prepared, model, ceiling, options, assertResume, {
    evidence,
    primary,
  });
  const allKeys = files.map((f) => f.key);
  for (const request of requests) {
    const own = [...(request.keys ?? allKeys)].filter((k) => primary.has(k));
    if (own.length === 0) continue;
    const paths = own.map(pathOf).sort();
    const part = `${batch.part}:req:${digest(paths)}`;
    if (batch.owned && !(await batch.owned())) {
      throw new MuseError('previous_failure', 'This run was superseded before a paid request');
    }
    const claimed = await claim(
      repositoryValues(prepared.subject, model, batch.repoId, commitSha, part),
      { retryFailed: !batch.automatic, fresh: batch.fresh },
    );
    if (claimed.kind === 'fresh') {
      await runClaimed(
        claimed.row,
        options,
        { requests: [request], schema: CandidateOutputSchema, timeoutMs: CANDIDATE_TIMEOUT_MS },
        scopesFor('candidate', prepared.subject, options.budgetNamespace),
        (outputs: CandidateOutput[]) =>
          verifyRequests(
            outputs,
            [request],
            evidence,
            { subject: prepared.subject, model },
            new Set(own),
          ),
        { inputManifest: manifest(paths) },
      );
    }
    for (const p of paths) done.add(p);
  }
  return done;
}

/** Core paths already covered by processed request rows of one part at one commit. */
export async function processedPaths(
  subject: PreparedCandidate['subject'],
  repoId: number,
  commitSha: string,
  part: string,
  since: Date,
  options: RunOptions = {},
): Promise<{ paths: Set<string>; failed: boolean }> {
  const model = selectedModel(options);
  const rows = await db
    .select()
    .from(skillAssessments)
    .where(
      and(
        eq(skillAssessments.kind, 'repository'),
        eq(skillAssessments.subjectKind, subject.kind),
        eq(skillAssessments.subjectKey, subject.key),
        eq(skillAssessments.repoId, repoId),
        eq(skillAssessments.model, model),
        sql`${skillAssessments.part} like ${`${part}:%`}`,
      ),
    );
  const paths = new Set<string>();
  let failed = false;
  for (const r of rows) {
    if (r.cacheKey !== repositoryRowKey(subject, model, repoId, commitSha, r.part!)) continue;
    if ((r.completedAt ?? r.startedAt) < since) continue;
    if (r.status === 'failed') failed = true;
    if (!(SAVED as readonly string[]).includes(r.status)) continue;
    for (const p of r.inputManifest?.paths ?? []) paths.add(p);
  }
  return { paths, failed };
}

/**
 * Re-examines one disputed marker in one repository. The justification is only a claim; the
 * outcome is `level`, a supported `removed`, or `inconclusive`. Saved as an overlay row that the
 * combined markers apply on top of that repository's parts; other skills keep their provenance.
 */
export async function analyzeReassessment(
  input: {
    prepared: PreparedCandidate;
    repoId: number;
    skillId: string;
    justification: string;
    /** Requested paths, and paths the current marker cites in this repository. */
    paths: string[];
    priorPaths: string[];
  },
  options: RunOptions = {},
): Promise<{ outcome: 'level' | 'removed' | 'inconclusive' }> {
  const { prepared } = input;
  const model = selectedModel(options);
  assertDataUse(model, [prepared.dataUse]);
  if (prepared.resume) {
    assertDataUse(model, [prepared.subject.kind === 'demo' ? 'approved_public_demo' : 'restricted']);
  }
  const repo = prepared.repos[0] as PreparedRepo;
  const commitSha = repo.snapshot.commitSha;
  const evidence = buildCandidateEvidence(prepared, { evidenceChars: Number.MAX_SAFE_INTEGER });
  const resume = prepared.resume?.text ?? null;
  const dispute = { skillId: input.skillId, justification: input.justification };
  const body = reassessmentBody(model, evidence.rendered, resume, dispute);
  const ceiling = options.inputTokenCeiling ?? DEFAULT_INPUT_TOKEN_CEILING;
  const inputTokens = await countTokens(museConfig(), body, {
    ...(options.fetch && { fetch: options.fetch }),
    ...(options.sleep && { sleep: options.sleep }),
    ...(options.onCount && { onCount: options.onCount }),
  });
  if (inputTokens > ceiling) throw new MuseError('input_too_large', 'Reassessment exceeds the ceiling');
  const part = `overlay:${randomUUID()}`;
  const claimed = await claim(
    repositoryValues(prepared.subject, model, input.repoId, commitSha, part),
    { retryFailed: true, fresh: true },
  );
  const manifest = (r: ReturnType<typeof verifyReassessment>): InputManifest => ({
    repos: [{ repo: `${repo.owner}/${repo.repo}`, commitSha, unavailable: null }],
    resumeSha256: resume === null ? null : sha256Hex(resume),
    paths: [...input.paths].sort(),
    reassessment: {
      skillId: input.skillId,
      outcome: r.outcome,
      rationale: r.rationale,
      paths: [...input.paths].sort(),
      justificationSha256: sha256Hex(input.justification),
    },
  });
  let verdict: ReturnType<typeof verifyReassessment> | undefined;
  await runClaimed(
    claimed.row,
    options,
    {
      requests: [{ body, inputTokens }],
      schema: ReassessmentOutputSchema as never,
      timeoutMs: CANDIDATE_TIMEOUT_MS,
    },
    scopesFor('candidate', prepared.subject, options.budgetNamespace),
    ([output]: ReassessmentOutput[]) => {
      verdict = verifyReassessment(output!, evidence, { subject: prepared.subject, model }, {
        skillId: input.skillId,
        priorPaths: input.priorPaths,
      });
      return scrubQuotedSource(verdict.assessment, evidence);
    },
    () => ({ inputManifest: manifest(verdict!) }),
  );
  return { outcome: verdict!.outcome };
}

// ---- Combined candidate markers ----

/** The combined row's key: the subject, model and active repository set, plus every version. */
export const combinedKey = (
  subject: PreparedCandidate['subject'],
  model: MuseModel,
  repoIds: number[],
) =>
  cacheKeyOf({
    kind: 'candidate',
    subject,
    model,
    repoIds: [...new Set(repoIds)].sort((a, b) => a - b),
  });

const lower = (s: string) => s.toLowerCase();

/**
 * The older combined result some selected repositories still rely on: the one already adopted, or
 * else the newest whose stored key matches the pre-selection fingerprint (candidateKey) of its own
 * repositories and the current résumé, so it was built from the same inputs and versions.
 */
async function legacyFor(
  subject: PreparedCandidate['subject'],
  model: MuseModel,
  selection: Selection[],
  resumeText: string | null,
) {
  const adopted = selection.find((s) => s.legacyAssessmentId !== null)?.legacyAssessmentId;
  const rows = await db
    .select()
    .from(skillAssessments)
    .where(
      and(
        eq(skillAssessments.kind, 'candidate'),
        eq(skillAssessments.subjectKind, subject.kind),
        eq(skillAssessments.subjectKey, subject.key),
        eq(skillAssessments.model, model),
        inArray(skillAssessments.status, [...SAVED]),
        adopted ? eq(skillAssessments.id, adopted) : sql`${skillAssessments.inputManifest} is not null`,
      ),
    )
    .orderBy(desc(skillAssessments.completedAt));
  const row = rows.find((r) => {
    if (!r.inputManifest || r.verifierVersion !== VERIFIER_VERSION) return false;
    if (adopted) return true;
    const repos = r.inputManifest.repos.map((m) => {
      const [owner, repo] = m.repo.split('/') as [string, string];
      return { owner, repo };
    });
    return r.cacheKey === candidateKey(subject, { repos, resumeText }, { model }).cacheKey;
  });
  if (!row?.inputManifest) return null;
  const usable = new Set(
    selection.filter((s) => s.assessedCommit === null).map((s) => lower(s.fullName)),
  );
  // Reassessments since the old result: a re-examined marker no longer holds across repositories.
  const nameOf = new Map(selection.map((s) => [s.repoId, lower(s.fullName)]));
  const overlays = await db
    .select({ repoId: skillAssessments.repoId, manifest: skillAssessments.inputManifest })
    .from(skillAssessments)
    .where(
      and(
        eq(skillAssessments.kind, 'repository'),
        eq(skillAssessments.subjectKind, subject.kind),
        eq(skillAssessments.subjectKey, subject.key),
        eq(skillAssessments.model, model),
        inArray(skillAssessments.status, [...SAVED]),
        sql`${skillAssessments.part} like 'overlay:%'`,
        sql`${skillAssessments.completedAt} > ${row.completedAt}`,
      ),
    );
  const overlaid = new Set(
    overlays.flatMap(({ repoId, manifest }) => {
      const re = manifest?.reassessment;
      const repo = repoId === null ? undefined : nameOf.get(repoId);
      return re && repo && re.outcome !== 'inconclusive' ? [`${repo}\n${re.skillId}`] : [];
    }),
  );
  const view = legacyView(
    CandidateAssessmentSchema.parse(row.result),
    row.inputManifest.repos,
    usable,
    overlaid,
  );
  return { row, view };
}

/**
 * Adopts, or drops, an older combined result per selected repository: a repository it still covers
 * honestly needs no download; one it no longer covers (a sibling was graded on its own and a marker
 * spanned both) is released for grading. Returns the repositories released this way.
 */
export async function syncLegacy(
  subject: PreparedCandidate['subject'],
  resumeText: string | null,
  options: RunOptions = {},
): Promise<Set<string>> {
  const model = selectedModel(options);
  const selection = await activeSelection(subject);
  const legacy = await legacyFor(subject, model, selection, resumeText);
  for (const s of selection) {
    const name = lower(s.fullName);
    // A split repository keeps its old single-repository markers but is graded on its own.
    const want =
      legacy?.view.covered.has(name) && !legacy.view.split.has(name) ? legacy.row.id : null;
    if (want === s.legacyAssessmentId) continue;
    // An adopted result dates the repository's markers, so later pushes are flagged as changes.
    const assessedAt = want ? legacy!.row.completedAt : s.assessedCommit ? s.assessedAt : null;
    await db
      .update(repositorySelections)
      .set({ legacyAssessmentId: want, assessedAt })
      .where(
        and(
          eq(repositorySelections.subjectKind, s.subjectKind),
          eq(repositorySelections.subjectKey, s.subjectKey),
          eq(repositorySelections.repoId, s.repoId),
        ),
      );
  }
  return legacy?.view.split ?? new Set();
}

/**
 * Rebuilds and saves the combined markers from the active selection: each repository's processed
 * rows at its assessed commit (or, while it is still being graded, those at its pinned commit),
 * the older result for repositories it still covers, then newer reassessment overlays. Rows from
 * older versions are ignored. Returns null for an empty selection, which has no markers at all.
 */
export async function combineCandidate(
  subject: PreparedCandidate['subject'],
  resumeText: string | null,
  options: RunOptions = {},
): Promise<CandidateAssessment | null> {
  const model = selectedModel(options);
  const selection = await activeSelection(subject);
  if (selection.length === 0) return null;
  const rows = await db
    .select()
    .from(skillAssessments)
    .where(
      and(
        eq(skillAssessments.kind, 'repository'),
        eq(skillAssessments.subjectKind, subject.kind),
        eq(skillAssessments.subjectKey, subject.key),
        eq(skillAssessments.model, model),
        inArray(skillAssessments.status, [...SAVED]),
        inArray(
          skillAssessments.repoId,
          selection.map((s) => s.repoId),
        ),
      ),
    )
    .orderBy(asc(skillAssessments.completedAt));
  const commitOf = (r: Row) => r.inputManifest?.repos[0]?.commitSha ?? '';
  const current = rows.filter(
    (r) => r.cacheKey === repositoryRowKey(subject, model, r.repoId!, commitOf(r), r.part!),
  );
  const legacy = await legacyFor(subject, model, selection, resumeText);

  const parts: { repo: string; assessment: CandidateAssessment }[] = [];
  const overlays: Overlay[] = [];
  const unavailable: CandidateAssessment['coverage']['unavailableRepos'] = [];
  const manifestRepos: InputManifest['repos'] = [];
  let legacyAdded = false;
  for (const s of selection) {
    const own = current.filter((r) => r.repoId === s.repoId && !r.part!.startsWith('overlay:'));
    const pick = (commit: string, since: Date | null) =>
      own.filter((r) => commitOf(r) === commit && (!since || r.completedAt! >= since));
    let used: Row[] = [];
    let commit: string | null = null;
    let base: Date | null = null;
    if (s.assessedCommit) {
      used = pick(s.assessedCommit, s.assessedSince);
      commit = s.assessedCommit;
      base = s.assessedAt;
      if (used.length === 0) unavailable.push({ repo: s.fullName, reason: 'outdated' });
    } else if (legacy?.view.covered.has(lower(s.fullName))) {
      // Every covered repository has its own legacy part, so overlays apply per repository.
      if (!legacyAdded) parts.push(...legacy.view.parts);
      legacyAdded = true;
      const entry = legacy.row.inputManifest!.repos.find((m) => lower(m.repo) === lower(s.fullName));
      commit = entry?.commitSha ?? null;
      base = legacy.row.completedAt;
      if (legacy.view.split.has(lower(s.fullName))) {
        unavailable.push({ repo: s.fullName, reason: 'legacy_split' });
      }
    } else {
      if (s.progress) {
        used = pick(s.progress.commitSha, new Date(s.progress.since));
        commit = s.progress.commitSha;
      }
      unavailable.push({
        repo: s.fullName,
        reason: used.length > 0 ? 'partially_processed' : (s.lastError ?? 'not_processed'),
      });
    }
    for (const r of used) {
      parts.push({
        repo: s.fullName,
        assessment: prefixRefs(CandidateAssessmentSchema.parse(r.result), r.id),
      });
    }
    for (const r of current) {
      const re = r.inputManifest?.reassessment;
      if (r.repoId !== s.repoId || !re || (base && r.completedAt! <= base)) continue;
      const result = prefixRefs(CandidateAssessmentSchema.parse(r.result), r.id);
      overlays.push({
        repo: s.fullName,
        skillId: re.skillId,
        outcome: re.outcome,
        skill: result.skills.find((k) => k.skillId === re.skillId) ?? null,
      });
    }
    manifestRepos.push({
      repo: s.fullName,
      commitSha: commit,
      unavailable: unavailable.find((u) => u.repo === s.fullName)?.reason ?? null,
    });
  }
  const combined = combineParts(applyOverlays(parts, overlays), unavailable, {
    subject,
    model,
  });
  const claimed = await claim(
    {
      kind: 'candidate',
      subjectKind: subject.kind,
      subjectKey: subject.key,
      cacheKey: combinedKey(
        subject,
        model,
        selection.map((s) => s.repoId),
      ),
      model,
      catalogueVersion: SKILL_CATALOGUE.version,
      status: 'pending',
    },
    { retryFailed: true, fresh: true },
  );
  await complete(
    claimed.row.id,
    combined.status,
    {
      result: combined,
      inputManifest: {
        repos: manifestRepos,
        resumeSha256: resumeText === null ? null : sha256Hex(resumeText),
      },
    },
    claimed.row.startedAt,
  );
  return combined;
}

type Provenance = { resumeSha256: (string | null)[]; attribution: ('complete' | 'limited')[] };

/** Résumé hashes and attribution states behind each selected repository's current parts. */
export async function repositoryProvenance(
  subject: PreparedCandidate['subject'],
  options: RunOptions = {},
): Promise<Map<number, Provenance>> {
  const model = selectedModel(options);
  const selection = await activeSelection(subject);
  const out = new Map<number, Provenance>();
  if (selection.length === 0) return out;
  const rows = await db
    .select({
      repoId: skillAssessments.repoId,
      manifest: skillAssessments.inputManifest,
      completedAt: skillAssessments.completedAt,
    })
    .from(skillAssessments)
    .where(
      and(
        eq(skillAssessments.kind, 'repository'),
        eq(skillAssessments.subjectKind, subject.kind),
        eq(skillAssessments.subjectKey, subject.key),
        eq(skillAssessments.model, model),
        inArray(skillAssessments.status, [...SAVED]),
        inArray(
          skillAssessments.repoId,
          selection.map((s) => s.repoId),
        ),
      ),
    );
  for (const s of selection) {
    const own = rows.filter(
      (r) =>
        r.repoId === s.repoId &&
        r.manifest?.repos[0]?.commitSha === s.assessedCommit &&
        (!s.assessedSince || r.completedAt! >= s.assessedSince),
    );
    out.set(s.repoId, {
      resumeSha256: own.map((r) => r.manifest?.resumeSha256 ?? null),
      attribution: own.map((r) => r.manifest?.attribution ?? 'complete'),
    });
  }
  return out;
}

// ---- Jobs ----

/** The cache key `analyzeJob` would claim; result reads use the same computation. */
export function jobFingerprint(job: JobInput, options: RunOptions = {}) {
  const model = selectedModel(options);
  const body = jobBody(model, job);
  const input: JobInput = {
    jobKey: job.jobKey,
    employerId: job.employerId,
    title: job.title,
    text: job.text,
    textSource: job.textSource,
  };
  return { model, body, input, cacheKey: cacheKeyOf({ kind: 'job', body, job: input }) };
}

export async function analyzeJob(
  job: PreparedJob,
  options: RunOptions = {},
): Promise<RunResult<JobAssessment>> {
  const model = selectedModel(options);
  assertDataUse(model, [job.dataUse]);
  const { body, input, cacheKey } = jobFingerprint(job, { ...options, model });
  const ceiling = options.inputTokenCeiling ?? DEFAULT_INPUT_TOKEN_CEILING;
  // Job text is never truncated: an oversized description is rejected instead.
  if (estimateTokens(body) > ceiling)
    throw new MuseError('input_too_large', 'Job description exceeds the ceiling');
  const claimed = await claim(
    {
      kind: 'job',
      subjectKind: 'demo',
      subjectKey: job.jobKey,
      cacheKey,
      model,
      catalogueVersion: SKILL_CATALOGUE.version,
      status: 'pending',
    },
    { retryFailed: options.retryFailed ?? false, fresh: options.fresh ?? false },
  );
  const { row } = claimed;
  if (claimed.kind === 'saved') {
    return { assessmentId: row.id, assessment: JobAssessmentSchema.parse(row.result), cached: true };
  }
  const assessment = await runClaimed(
    row,
    options,
    { requests: [{ body }], schema: JobOutputSchema, timeoutMs: JOB_TIMEOUT_MS },
    scopesFor('job', { kind: 'demo', key: job.jobKey }, options.budgetNamespace),
    ([output]: ReturnType<typeof JobOutputSchema.parse>[]) => verifyJob(output!, input, model),
  );
  return { assessmentId: row.id, assessment, cached: false };
}

// ---- Read-only lookup ----

export type Lookup<T> =
  | {
      state: 'current';
      assessment: T;
      completedAt: Date | null;
      inputManifest: InputManifest | null;
    }
  | { state: 'pending' }
  | { state: 'failed'; errorCode: string | null }
  | { state: 'outdated' }
  | { state: 'not_started' };

/**
 * The newest saved result for exactly this input key. Read-only, so a read can never mark an older
 * input's result as current. A newer pending or failed run of the same input does not hide it.
 */
export async function assessmentByFingerprint<K extends 'candidate' | 'job'>(
  kind: K,
  subject: { kind: 'demo' | 'user'; key: string },
  cacheKey: string,
): Promise<Lookup<K extends 'candidate' ? CandidateAssessment : JobAssessment>> {
  type T = K extends 'candidate' ? CandidateAssessment : JobAssessment;
  const ofSubject = and(
    eq(skillAssessments.kind, kind),
    eq(skillAssessments.subjectKind, subject.kind),
    eq(skillAssessments.subjectKey, subject.key),
  );
  const rows = await db
    .select()
    .from(skillAssessments)
    .where(and(ofSubject, eq(skillAssessments.cacheKey, cacheKey)))
    .orderBy(desc(skillAssessments.startedAt));
  const saved = rows.find((r) => (SAVED as readonly string[]).includes(r.status));
  if (saved) {
    const schema = kind === 'candidate' ? CandidateAssessmentSchema : JobAssessmentSchema;
    return {
      state: 'current',
      assessment: schema.parse(saved.result) as T,
      completedAt: saved.completedAt,
      inputManifest: saved.inputManifest,
    };
  }
  const latest = rows[0];
  if (latest?.status === 'pending') return { state: 'pending' };
  if (latest?.status === 'failed') return { state: 'failed', errorCode: latest.errorCode };
  const [older] = await db
    .select({ id: skillAssessments.id })
    .from(skillAssessments)
    .where(ofSubject)
    .limit(1);
  return older ? { state: 'outdated' } : { state: 'not_started' };
}

// ---- Overrides and matching ----

export async function setPriorityOverride(input: unknown): Promise<PriorityOverride> {
  const parsed = PriorityOverrideSchema.safeParse(input);
  if (!parsed.success) throw new RangeError('Invalid priority override');
  const { jobKey, skillId, priority } = parsed.data;
  await db
    .insert(jobPriorityOverrides)
    .values({ jobKey, skillId, priority })
    .onConflictDoUpdate({
      target: [jobPriorityOverrides.jobKey, jobPriorityOverrides.skillId],
      set: { priority, updatedAt: new Date() },
    });
  return parsed.data;
}

/** Resets one requirement to its suggested priority. */
export async function clearPriorityOverride(jobKey: string, skillId: string): Promise<void> {
  await db
    .delete(jobPriorityOverrides)
    .where(and(eq(jobPriorityOverrides.jobKey, jobKey), eq(jobPriorityOverrides.skillId, skillId)));
}

async function latestSaved(
  kind: 'candidate' | 'job',
  subject: { kind: string; key: string },
  model: MuseModel,
) {
  const [row] = await db
    .select()
    .from(skillAssessments)
    .where(
      and(
        eq(skillAssessments.kind, kind),
        eq(skillAssessments.subjectKind, subject.kind as 'demo' | 'user'),
        eq(skillAssessments.subjectKey, subject.key),
        eq(skillAssessments.model, model),
        inArray(skillAssessments.status, [...SAVED]),
      ),
    )
    .orderBy(desc(skillAssessments.completedAt))
    .limit(1);
  return row;
}

/** Matches saved assessments from the same model. Failed analyses are never scored. */
export async function matchSaved(
  subject: { kind: 'demo' | 'user'; key: string },
  jobKey: string,
  options: { model?: MuseModel } = {},
): Promise<MatchResult> {
  const model = selectedModel(options);
  // With a selection, only the combined markers for exactly that selection count.
  const selection = await activeSelection(subject);
  const candidateRow =
    selection.length === 0
      ? await latestSaved('candidate', subject, model)
      : (
          await db
            .select()
            .from(skillAssessments)
            .where(
              and(
                eq(
                  skillAssessments.cacheKey,
                  combinedKey(
                    subject,
                    model,
                    selection.map((s) => s.repoId),
                  ),
                ),
                inArray(skillAssessments.status, [...SAVED]),
              ),
            )
            .orderBy(desc(skillAssessments.completedAt))
            .limit(1)
        )[0];
  const jobRow = await latestSaved('job', { kind: 'demo', key: jobKey }, model);
  if (!candidateRow || !jobRow)
    throw new RangeError('Both assessments must be saved before matching');
  const overrides = await db
    .select()
    .from(jobPriorityOverrides)
    .where(eq(jobPriorityOverrides.jobKey, jobKey));
  return matchAssessments(
    CandidateAssessmentSchema.parse(candidateRow.result),
    JobAssessmentSchema.parse(jobRow.result),
    new Map(overrides.map((o) => [o.skillId, o.priority])),
  );
}
