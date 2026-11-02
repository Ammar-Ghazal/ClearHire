// Runs and stores candidate and job assessments. One row per content-addressed cache key acts as the
// cache, the saved result and the lock that stops duplicate paid calls. Spend is reserved atomically
// across scopes before every attempt and settled conservatively afterwards.
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
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  jobPriorityOverrides,
  museCalls,
  museSpendBudgets,
  skillAssessments,
} from '../db/schema.js';
import { env } from '../env.js';
import {
  verifyCandidate,
  verifyJob,
  VERIFIER_VERSION,
  type JobInput,
} from './assessment-verify.js';
import { ATTRIBUTION_VERSION } from './attribution.js';
import {
  buildCandidateEvidence,
  SELECTION_VERSION,
  type CandidateEvidence,
  type DataUse,
  type PreparedCandidate,
} from './candidate-evidence.js';
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
  DEFAULT_INPUT_TOKEN_CEILING,
  estimateTokens,
  jobBody,
  JobOutputSchema,
  JOB_MAX_COMPLETION_TOKENS,
  MuseError,
  PROMPT_VERSION,
  SCHEMA_VERSION,
  type AttemptSettlement,
  type ChatBody,
  type MuseLedger,
  type MuseModel,
} from './muse.js';
import { CLEANER_VERSION, sha256Hex } from './packets.js';

export const CANDIDATE_TIMEOUT_MS = 600_000;
export const JOB_TIMEOUT_MS = 120_000;
export const HEARTBEAT_MS = 30_000;
/** A pending row is stale only when its runner has not refreshed it for this long. */
export const staleAfterMs = (kind: 'candidate' | 'job') =>
  (kind === 'candidate' ? CANDIDATE_TIMEOUT_MS : JOB_TIMEOUT_MS) + 120_000;

const SAVED = ['complete', 'partial', 'no_attributed_evidence'] as const;
type Saved = (typeof SAVED)[number];
type Row = typeof skillAssessments.$inferSelect;
const usd = (dollars: number) => Math.round(dollars * 1_000_000);

export interface PreparedJob extends JobInput {
  dataUse: DataUse;
}

export interface RunOptions {
  model?: MuseModel;
  inputTokenCeiling?: number;
  /** Re-runs a failed assessment; failures are never resent automatically. */
  retryFailed?: boolean;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
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

function scopesFor(kind: 'candidate' | 'job', subject: { kind: string; key: string }, ns = '') {
  const day = new Date().toISOString().slice(0, 10);
  return [
    { scope: `${ns}daily:${day}`, cap: usd(env.META_DAILY_CAP_USD) },
    {
      scope: `${ns}subject:${kind}:${subject.kind}:${subject.key}`,
      cap: usd(env.META_SUBJECT_CAP_USD),
    },
  ].sort((a, b) => (a.scope < b.scope ? -1 : 1));
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Call = typeof museCalls.$inferSelect;

/** Settles one locked, still-reserved call inside the caller's transaction. */
async function settleLocked(tx: Tx, call: Call, s: AttemptSettlement): Promise<void> {
  for (const scope of [...call.scopes].sort()) {
    await tx
      .update(museSpendBudgets)
      .set({
        reservedMicroUsd: sql`${museSpendBudgets.reservedMicroUsd} - ${call.reservedMicroUsd}`,
        spentMicroUsd: sql`${museSpendBudgets.spentMicroUsd} + ${s.costMicroUsd}`,
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
  kind: 'candidate' | 'job';
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

async function claim(
  values: typeof skillAssessments.$inferInsert,
  retryFailed: boolean,
): Promise<Claim> {
  // Millisecond timestamps, so `startedAt` round-trips exactly as the run token.
  const now = new Date();
  const [inserted] = await db
    .insert(skillAssessments)
    .values({ ...values, startedAt: now, heartbeatAt: now })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { kind: 'fresh', row: inserted };

  const [row] = await db
    .select()
    .from(skillAssessments)
    .where(eq(skillAssessments.cacheKey, values.cacheKey));
  if (!row) throw new MuseError('in_progress', 'Assessment is being claimed by another runner');
  if ((SAVED as readonly string[]).includes(row.status)) return { kind: 'saved', row };
  if (row.status === 'pending') {
    if (await failStale(row.id)) {
      throw new MuseError('previous_failure', 'A previous run was interrupted; retry explicitly');
    }
    throw new MuseError('in_progress', 'An identical assessment is already running');
  }
  if (!retryFailed) {
    throw new MuseError(
      'previous_failure',
      `A previous run failed (${row.errorCode ?? 'unknown'})`,
    );
  }
  const [reclaimed] = await db
    .update(skillAssessments)
    .set({
      status: 'pending',
      errorCode: null,
      startedAt: new Date(),
      heartbeatAt: new Date(),
      completedAt: null,
    })
    .where(and(eq(skillAssessments.id, row.id), eq(skillAssessments.status, 'failed')))
    .returning();
  if (!reclaimed) throw new MuseError('in_progress', 'An identical assessment is already running');
  return { kind: 'fresh', row: reclaimed };
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

async function fail(id: string, run: Date, err: unknown, rawOutput?: unknown) {
  const code = err instanceof MuseError ? err.code : 'internal_error';
  await db
    .update(skillAssessments)
    .set({
      status: 'failed',
      errorCode: code,
      completedAt: new Date(),
      ...(rawOutput !== undefined && { rawOutput }),
    })
    .where(currentRun(id, run));
}

/** Runs one paid call for a freshly claimed row, keeping its heartbeat alive meanwhile. */
async function runClaimed<O, A>(
  row: Row,
  options: RunOptions,
  call: {
    body: ChatBody;
    schema: typeof CandidateOutputSchema | typeof JobOutputSchema;
    timeoutMs: number;
  },
  scopes: { scope: string; cap: number }[],
  verify: (output: O) => A & { status?: string },
  evidence: unknown,
): Promise<A> {
  const heartbeat = setInterval(() => {
    void db
      .update(skillAssessments)
      .set({ heartbeatAt: new Date() })
      .where(currentRun(row.id, row.startedAt))
      .catch(() => {});
  }, HEARTBEAT_MS);
  let output: O | undefined;
  try {
    const result = await callMuse({
      config: museConfig(),
      body: call.body,
      schema: call.schema as never,
      timeoutMs: options.timeoutMs ?? call.timeoutMs,
      ledger: dbLedger(row.id, call.body.model, scopes, row.startedAt),
      ...(options.fetch && { fetch: options.fetch }),
      ...(options.sleep && { sleep: options.sleep }),
    });
    output = result.data as O;
    const assessment = verify(output);
    const status = (assessment.status === 'partial' ? 'partial' : 'complete') as Saved;
    const saved = await complete(
      row.id,
      status,
      { rawOutput: output, evidence, result: assessment },
      row.startedAt,
    );
    if (!saved)
      throw new MuseError('previous_failure', 'This run was superseded; its result was discarded');
    return assessment;
  } catch (err) {
    await fail(row.id, row.startedAt, err, output);
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
}

// ---- Candidates ----

/** Fits all selected repositories and the resume into one request under the input ceiling. */
function fitCandidate(prepared: PreparedCandidate, model: MuseModel, ceiling: number) {
  const resume = prepared.resume?.text ?? null;
  const fixed = estimateTokens(candidateBody(model, '', resume));
  if (fixed >= ceiling)
    throw new MuseError('input_too_large', 'Catalogue, rules and resume exceed the ceiling');
  let evidenceChars = Math.floor((ceiling - fixed) * 3 * 0.9);
  for (let i = 0; i < 6; i++) {
    const evidence = buildCandidateEvidence(prepared, { evidenceChars });
    const body = candidateBody(model, evidence.rendered, resume);
    if (estimateTokens(body) <= ceiling) return { evidence, body };
    evidenceChars = Math.floor(evidenceChars * 0.8);
  }
  throw new MuseError('input_too_large', 'Evidence could not be fitted under the input ceiling');
}

const storedEvidence = ({ rendered: _rendered, ...rest }: CandidateEvidence) => rest;

function reverifyCandidate(row: Row): CandidateAssessment {
  const stored = CandidateAssessmentSchema.parse(row.result);
  if (row.verifierVersion === VERIFIER_VERSION || row.rawOutput === null) return stored;
  const evidence = { ...(row.evidence as Omit<CandidateEvidence, 'rendered'>), rendered: '' };
  const output = CandidateOutputSchema.parse(row.rawOutput);
  return verifyCandidate(output, evidence, {
    subject: stored.subject,
    model: row.model as MuseModel,
  });
}

/**
 * The cache key `analyzeCandidate` would claim, with the evidence and body behind it. Pure apart
 * from configuration, so result reads use exactly the same inputs as analysis.
 */
export function candidateFingerprint(prepared: PreparedCandidate, options: RunOptions = {}) {
  const model = selectedModel(options);
  const ceiling = options.inputTokenCeiling ?? DEFAULT_INPUT_TOKEN_CEILING;
  if (ceiling + CANDIDATE_MAX_COMPLETION_TOKENS > CONTEXT_WINDOW) {
    throw new MuseError(
      'input_too_large',
      'Input ceiling leaves no room for output in the context window',
    );
  }
  const { evidence, body } = fitCandidate(prepared, model, ceiling);
  const evidenceHash = sha256Hex(canonicalJson(storedEvidence(evidence)));
  const noEvidence = evidence.citableCount === 0;
  const { subject } = prepared;
  const cacheKey = cacheKeyOf(
    noEvidence
      ? { kind: 'candidate', subject, model, evidenceHash, noAttributedEvidence: true }
      : { kind: 'candidate', subject, body, evidenceHash },
  );
  return { model, evidence, body, noEvidence, cacheKey };
}

export async function analyzeCandidate(
  prepared: PreparedCandidate,
  options: RunOptions = {},
): Promise<RunResult<CandidateAssessment>> {
  const model = selectedModel(options);
  assertDataUse(model, [prepared.dataUse]);
  const { evidence, body, noEvidence, cacheKey } = candidateFingerprint(prepared, {
    ...options,
    model,
  });
  // Resume text is restricted data. Checked before claim() so a refusal leaves no pending row;
  // the no-evidence branch sends nothing, so it needs no check.
  if (!noEvidence && prepared.resume) assertDataUse(model, ['restricted']);

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
    options.retryFailed ?? false,
  );
  const { row } = claimed;
  if (claimed.kind === 'saved') {
    const assessment = reverifyCandidate(row);
    if (row.verifierVersion !== VERIFIER_VERSION) {
      await complete(row.id, assessment.status, { result: assessment });
    }
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
      { evidence: storedEvidence(evidence), result: assessment },
      row.startedAt,
    );
    return { assessmentId: row.id, assessment, cached: false };
  }

  const assessment = await runClaimed(
    row,
    options,
    { body, schema: CandidateOutputSchema, timeoutMs: CANDIDATE_TIMEOUT_MS },
    scopesFor('candidate', prepared.subject, options.budgetNamespace),
    (output: ReturnType<typeof CandidateOutputSchema.parse>) =>
      verifyCandidate(output, evidence, { subject: prepared.subject, model }),
    storedEvidence(evidence),
  );
  return { assessmentId: row.id, assessment, cached: false };
}

// ---- Jobs ----

function reverifyJob(row: Row): JobAssessment {
  const stored = JobAssessmentSchema.parse(row.result);
  if (row.verifierVersion === VERIFIER_VERSION || row.rawOutput === null) return stored;
  return verifyJob(
    JobOutputSchema.parse(row.rawOutput),
    row.evidence as JobInput,
    row.model as MuseModel,
  );
}

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
    options.retryFailed ?? false,
  );
  const { row } = claimed;
  if (claimed.kind === 'saved') {
    const assessment = reverifyJob(row);
    if (row.verifierVersion !== VERIFIER_VERSION)
      await complete(row.id, 'complete', { result: assessment });
    return { assessmentId: row.id, assessment, cached: true };
  }
  const assessment = await runClaimed(
    row,
    options,
    { body, schema: JobOutputSchema, timeoutMs: JOB_TIMEOUT_MS },
    scopesFor('job', { kind: 'demo', key: job.jobKey }, options.budgetNamespace),
    (output: ReturnType<typeof JobOutputSchema.parse>) => verifyJob(output, input, model),
    input,
  );
  return { assessmentId: row.id, assessment, cached: false };
}

// ---- Read-only lookup ----

export type Lookup<T> =
  | { state: 'current'; assessment: T; completedAt: Date | null }
  | { state: 'pending' }
  | { state: 'failed'; errorCode: string | null }
  | { state: 'outdated' }
  | { state: 'not_started' };

/**
 * The saved result for exactly this fingerprint. Re-verifies in memory and never writes, so a
 * read can never mark an older input's result as current.
 */
export async function assessmentByFingerprint<K extends 'candidate' | 'job'>(
  kind: K,
  subject: { kind: 'demo' | 'user'; key: string },
  cacheKey: string,
): Promise<Lookup<K extends 'candidate' ? CandidateAssessment : JobAssessment>> {
  type T = K extends 'candidate' ? CandidateAssessment : JobAssessment;
  const [row] = await db
    .select()
    .from(skillAssessments)
    .where(
      and(
        eq(skillAssessments.cacheKey, cacheKey),
        eq(skillAssessments.kind, kind),
        eq(skillAssessments.subjectKind, subject.kind),
        eq(skillAssessments.subjectKey, subject.key),
      ),
    );
  if (row && (SAVED as readonly string[]).includes(row.status)) {
    const assessment = kind === 'candidate' ? reverifyCandidate(row) : reverifyJob(row);
    return { state: 'current', assessment: assessment as T, completedAt: row.completedAt };
  }
  if (row?.status === 'pending') return { state: 'pending' };
  if (row?.status === 'failed') return { state: 'failed', errorCode: row.errorCode };
  const [older] = await db
    .select({ id: skillAssessments.id })
    .from(skillAssessments)
    .where(
      and(
        eq(skillAssessments.kind, kind),
        eq(skillAssessments.subjectKind, subject.kind),
        eq(skillAssessments.subjectKey, subject.key),
      ),
    )
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
  const candidateRow = await latestSaved('candidate', subject, model);
  const jobRow = await latestSaved('job', { kind: 'demo', key: jobKey }, model);
  if (!candidateRow || !jobRow)
    throw new RangeError('Both assessments must be saved before matching');
  const overrides = await db
    .select()
    .from(jobPriorityOverrides)
    .where(eq(jobPriorityOverrides.jobKey, jobKey));
  return matchAssessments(
    reverifyCandidate(candidateRow),
    reverifyJob(jobRow),
    new Map(overrides.map((o) => [o.skillId, o.priority])),
  );
}
