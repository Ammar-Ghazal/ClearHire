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
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  jobPriorityOverrides,
  museCalls,
  museSpendBudgets,
  skillAssessments,
  type InputManifest,
} from '../db/schema.js';
import { env } from '../env.js';
import {
  isIncomplete,
  scrubQuotedSource,
  verifyCandidate,
  verifyJob,
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
  type PreparedCandidate,
} from './candidate-evidence.js';
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
  countInputTokens,
  DEFAULT_INPUT_TOKEN_CEILING,
  estimateTokens,
  jobBody,
  JobOutputSchema,
  JOB_MAX_COMPLETION_TOKENS,
  MuseError,
  PROMPT_VERSION,
  SCHEMA_VERSION,
  type AttemptSettlement,
  type CandidateOutput,
  type ChatBody,
  type MuseLedger,
  type MuseModel,
  type RateLimiter,
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
  fields: Partial<typeof skillAssessments.$inferInsert> = {},
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
    const saved = await complete(row.id, status, { ...fields, result: assessment }, row.startedAt);
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
 * Plans the requests for all selected repositories and the resume, each measured on its whole body:
 * catalogue, rules, schema, resume, dependencies and code. Everything goes in one request when it
 * fits under the ceiling; otherwise the evidence is split across requests (see packParts), so no
 * code is truncated or dropped.
 */
async function planCandidate(
  prepared: PreparedCandidate,
  model: MuseModel,
  ceiling: number,
  options: RunOptions,
  /** Data-use check that must pass before a count sends anything to Muse. */
  beforeSend: () => void,
): Promise<{ evidence: CandidateEvidence; requests: CandidateRequest[] }> {
  const resume = prepared.resume?.text ?? null;
  const fixed = estimateTokens(candidateBody(model, '', resume));
  if (fixed >= ceiling)
    throw new MuseError('input_too_large', 'Catalogue, rules and resume exceed the ceiling');
  const evidence = buildCandidateEvidence(prepared, { evidenceChars: Number.MAX_SAFE_INTEGER });
  const whole = candidateBody(model, evidence.rendered, resume);
  const estimate = estimateTokens(whole);
  // Below half the ceiling even a 2x underestimate fits; nearer, count exactly. A failed count
  // keeps the estimate, which overstated every recorded request. Nothing is sent without evidence.
  if (estimate <= ceiling / 2 || evidence.citableCount === 0) {
    return { evidence, requests: [{ body: whole, inputTokens: estimate, keys: null }] };
  }
  beforeSend();
  const count = async (body: ChatBody) =>
    (await countInputTokens(museConfig(), body, options.fetch)) ?? estimateTokens(body);
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
  const pending = packParts(evidence.layout, tokens, budget);
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
    const keys = requests[i]!.keys;
    if (keys === null) return verifyCandidate(output, all, meta);
    const refs = new Set([...keys].flatMap((k) => files.get(k)!.refs));
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
  const candidateRow = await latestSaved('candidate', subject, model);
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
