import { randomUUID } from 'node:crypto';
import { and, eq, like } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Real Postgres, mocked Muse: no request leaves the process and no real budget row is touched.
vi.mock('../env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../env.js')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      META_API_KEY: 'test-key',
      META_MODEL: 'muse-spark-1.3-contributor',
      META_BASE_URL: 'https://muse.test/v1',
      META_DAILY_CAP_USD: 100,
      META_SUBJECT_CAP_USD: 10,
    },
  };
});

const { db, databaseIsUp, pool } = await import('../db/client.js');
const { jobPriorityOverrides, museCalls, museSpendBudgets, skillAssessments } =
  await import('../db/schema.js');
const {
  analyzeCandidate,
  analyzeJob,
  assessmentByFingerprint,
  candidateKey,
  dbLedger,
  jobFingerprint,
  matchSaved,
  recoverStaleAssessments,
  scopesFor,
  setPriorityOverride,
} = await import('./assessments.js');
const { fixtureCandidate, fixtureRepo, sourceLines } = await import('./candidate-fixtures.js');
const { withCounts } = await import('./test-grading.js');

const RUN = `test-${randomUUID()}`;
const NS = `${RUN}:`;
const OPTIONS = { budgetNamespace: NS, sleep: async () => {} };
const up = await databaseIsUp();

const JOB_OUTPUT = {
  in_scope: true,
  out_of_scope_reason: null,
  requirements: [
    { skill_id: 'unit-testing', required_level: 2, suggested_priority: 2, refs: ['j1'] },
  ],
  eligibility_constraints: [],
  supporting_tags: [],
};
const CANDIDATE_OUTPUT = {
  repositories: [
    {
      repo: 'r1',
      functionality: [],
      quality_observations: [],
      limitations: [],
      contribution: { summary: 'Wrote tests', refs: ['a1'] },
    },
  ],
  skills: [
    {
      skill_id: 'unit-testing',
      level: 1,
      confidence: 'high',
      justification: 'Tests',
      evidence_refs: ['a1'],
      supporting_tags: [],
    },
  ],
};

function completion(content: unknown, finish = 'stop') {
  return new Response(
    JSON.stringify({
      id: 'resp',
      choices: [
        { finish_reason: finish, message: { content: JSON.stringify(content), refusal: null } },
      ],
      usage: { prompt_tokens: 1000, completion_tokens: 100 },
    }),
    { status: 200 },
  );
}

/** Queued answers for paid requests; token counts are answered on the side at 1,000 tokens. */
function fakeFetch(...responses: (Response | Error | (() => Promise<Response>))[]) {
  return vi.fn(async (url?: string) => {
    if (String(url).endsWith('/responses/input_tokens')) {
      return new Response(JSON.stringify({ input_tokens: 1000 }));
    }
    const next = responses.shift() ?? new Error('Unexpected Muse request');
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  });
}

/** Paid (chat) requests a fake fetch received; token counts are not paid. */
const chats = (fetchMock: { mock: { calls: unknown[][] } }) =>
  fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/chat/completions')).length;

const job = (
  suffix: string,
  dataUse: 'approved_public_demo' | 'restricted' = 'approved_public_demo',
) => ({
  jobKey: `${RUN}-${suffix}`,
  employerId: 'acme',
  title: 'Engineer',
  text: `Write unit tests (${suffix})`,
  textSource: 'full_description' as const,
  dataUse,
});

const attributedRepo = () =>
  fixtureRepo(
    'one',
    [{ path: 'src/a.ts', content: sourceLines(30) }],
    [{ sha: 'c1', path: 'src/a.ts', start: 1, end: 5 }],
  );

async function budget(scope: string) {
  const [row] = await db.select().from(museSpendBudgets).where(eq(museSpendBudgets.scope, scope));
  return row;
}

afterAll(async () => {
  if (up) {
    await db.delete(skillAssessments).where(like(skillAssessments.subjectKey, `${RUN}%`));
    await db.delete(museSpendBudgets).where(like(museSpendBudgets.scope, `${NS}%`));
    await db.delete(jobPriorityOverrides).where(like(jobPriorityOverrides.jobKey, `${RUN}%`));
  }
  await pool.end();
});

// Recorded from the current code: a change here means every saved assessment silently becomes
// outdated. They also change when the catalogue or a prompt/schema/cleaner/selection/attribution
// version does.
const GOLDEN = {
  candidate: '6b46d4130fea435fdcc26522deb6aec90f94b2f97df781663626f6b36c08791c',
  job: '53058cc1ade4420e6c2c3daa9e0fee7eed7979031e5d2991002dc89aebe51c93',
};
const unattributedRepo = () =>
  fixtureRepo('two', [{ path: 'src/b.ts', content: sourceLines(10) }], []);
const MODEL = { model: 'muse-spark-1.3-contributor' as const };
const keyOf = (c: ReturnType<typeof fixtureCandidate>) =>
  candidateKey(c.subject, { repos: c.repos, resumeText: c.resume?.text ?? null }).cacheKey;

describe('input keys', () => {
  it('reproduce the recorded keys', () => {
    const subject = { kind: 'demo' as const, key: 'golden-evidence' };
    const repos = [{ owner: 'octo', repo: 'one' }];
    expect(candidateKey(subject, { repos, resumeText: null }, MODEL).cacheKey).toBe(
      GOLDEN.candidate,
    );
    const posting = { ...job('x'), jobKey: 'golden-job', text: 'Write unit tests' };
    expect(jobFingerprint(posting, MODEL).cacheKey).toBe(GOLDEN.job);
  });

  it('come from the selection and résumé, never from repository content', () => {
    const subject = { kind: 'demo' as const, key: 'golden-evidence' };
    const key = (repos: { owner: string; repo: string }[], resumeText: string | null = null) =>
      candidateKey(subject, { repos, resumeText }, MODEL).cacheKey;
    // A fetched snapshot and stored metadata agree, whatever code the repository holds.
    const otherCode = fixtureRepo('one', [{ path: 'src/z.ts', content: sourceLines(3, 'z') }], []);
    expect(keyOf(fixtureCandidate([attributedRepo()], { subject }))).toBe(
      key([{ owner: 'octo', repo: 'one' }]),
    );
    expect(keyOf(fixtureCandidate([otherCode], { subject }))).toBe(GOLDEN.candidate);
    expect(keyOf(fixtureCandidate([attributedRepo(), unattributedRepo()], { subject }))).not.toBe(
      GOLDEN.candidate,
    );
    expect(key([{ owner: 'Octo', repo: 'One' }])).toBe(GOLDEN.candidate);
    expect(key([{ owner: 'octo', repo: 'one' }], 'Claims Kubernetes')).not.toBe(GOLDEN.candidate);
  });

  it('give each candidate only their own lifetime $15 scope, outside the daily cap', () => {
    expect(scopesFor('candidate', { kind: 'demo', key: 'a' })).toEqual([
      { scope: 'subject:candidate:demo:a', cap: 15_000_000 },
    ]);
    expect(scopesFor('candidate', { kind: 'user', key: 'u' })).toEqual([
      { scope: 'subject:candidate:user:u', cap: 15_000_000 },
    ]);
    expect(scopesFor('job', { kind: 'demo', key: 'j' }).map((s) => s.scope)).toEqual([
      expect.stringMatching(/^daily:/),
      'subject:job:demo:j',
    ]);
  });
});

describe.runIf(up)('assessments (Postgres)', () => {
  it('reserves every scope atomically under concurrency', async () => {
    const [row] = await db
      .insert(skillAssessments)
      .values({
        kind: 'job',
        subjectKind: 'demo',
        subjectKey: `${RUN}-ledger`,
        cacheKey: `${RUN}-ledger`,
        model: 'muse-spark-1.3',
        catalogueVersion: 2,
        status: 'pending',
        startedAt: new Date(),
      })
      .returning();
    const ledger = dbLedger(
      row!.id,
      'muse-spark-1.3',
      [
        { scope: `${NS}tight`, cap: 250 },
        { scope: `${NS}wide`, cap: 10_000 },
      ],
      row!.startedAt,
    );
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => ledger.reserve(1, 100)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(
      results
        .filter((r) => r.status === 'rejected')
        .map((r) => (r.reason as { code: string }).code),
    ).toEqual(['budget_exceeded', 'budget_exceeded', 'budget_exceeded']);
    expect((await budget(`${NS}tight`))!.reservedMicroUsd).toBe(200);
    expect((await budget(`${NS}wide`))!.reservedMicroUsd).toBe(200);
  });

  it('makes one paid call for concurrent requests and caches per model', async () => {
    let release!: () => void;
    let started!: () => void;
    const fetchStarted = new Promise<void>((r) => (started = r));
    const fetchMock = fakeFetch(
      () =>
        new Promise((resolve) => {
          started();
          release = () => resolve(completion(JOB_OUTPUT));
        }),
      completion(JOB_OUTPUT),
    );
    const options = { ...OPTIONS, fetch: fetchMock as unknown as typeof fetch };

    const first = analyzeJob(job('single'), options);
    await fetchStarted;
    await expect(analyzeJob(job('single'), options)).rejects.toMatchObject({ code: 'in_progress' });
    release();
    await expect(first).resolves.toMatchObject({ cached: false });

    const again = await analyzeJob(job('single'), options);
    expect(again.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const standard = await analyzeJob(job('single'), { ...options, model: 'muse-spark-1.3' });
    expect(standard).toMatchObject({ cached: false, assessment: { model: 'muse-spark-1.3' } });
    expect(standard.assessmentId).not.toBe(again.assessmentId);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses Contributor mode for restricted data before any request', async () => {
    const fetchMock = fakeFetch();
    await expect(
      analyzeJob(job('restricted', 'restricted'), { ...OPTIONS, fetch: fetchMock as never }),
    ).rejects.toMatchObject({ code: 'contributor_not_permitted' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caches partial and no-attributed-evidence results', async () => {
    const fetchMock = fakeFetch(completion(CANDIDATE_OUTPUT));
    const options = { ...OPTIONS, fetch: fetchMock as unknown as typeof fetch };
    const partial = fixtureCandidate(
      [attributedRepo(), { owner: 'octo', repo: 'gone', unavailable: 'not_found' }],
      { subject: { kind: 'demo', key: `${RUN}-partial` } },
    );
    const first = await analyzeCandidate(partial, options);
    expect(first.assessment).toMatchObject({
      status: 'partial',
      skills: [{ skillId: 'unit-testing' }],
    });
    expect((await analyzeCandidate(partial, options)).cached).toBe(true);

    const none = fixtureCandidate(
      [
        fixtureRepo(
          'two',
          [{ path: 'src/a.ts', content: sourceLines(5) }],
          [{ sha: 'x', path: 'src/a.ts', start: 1, end: 2, author: 'other' }],
        ),
      ],
      { subject: { kind: 'demo', key: `${RUN}-none` } },
    );
    expect((await analyzeCandidate(none, options)).assessment.status).toBe(
      'no_attributed_evidence',
    );
    expect((await analyzeCandidate(none, options)).cached).toBe(true);
    expect(chats(fetchMock)).toBe(1);
  });

  it('fails truncated output and resends only on explicit retry', async () => {
    const fetchMock = fakeFetch(completion(JOB_OUTPUT, 'length'), completion(JOB_OUTPUT));
    const options = { ...OPTIONS, fetch: fetchMock as unknown as typeof fetch };
    await expect(analyzeJob(job('truncated'), options)).rejects.toMatchObject({
      code: 'truncated',
    });
    const [row] = await db
      .select()
      .from(skillAssessments)
      .where(eq(skillAssessments.subjectKey, `${RUN}-truncated`));
    expect(row).toMatchObject({ status: 'failed', errorCode: 'truncated', result: null });

    await expect(analyzeJob(job('truncated'), options)).rejects.toMatchObject({
      code: 'previous_failure',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(
      analyzeJob(job('truncated'), { ...options, retryFailed: true }),
    ).resolves.toMatchObject({
      cached: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('moves a timed-out reservation to estimated spend and flags it', async () => {
    const fetchMock = fakeFetch(Object.assign(new Error('t'), { name: 'TimeoutError' }));
    await expect(
      analyzeJob(job('timeout'), { ...OPTIONS, fetch: fetchMock as never }),
    ).rejects.toMatchObject({ code: 'timeout' });
    const [row] = await db
      .select()
      .from(skillAssessments)
      .where(eq(skillAssessments.subjectKey, `${RUN}-timeout`));
    const [call] = await db.select().from(museCalls).where(eq(museCalls.assessmentId, row!.id));
    expect(call).toMatchObject({ settlement: 'ambiguous', costSource: 'reservation' });
    expect(call!.costMicroUsd).toBe(call!.reservedMicroUsd);
    const subject = await budget(`${NS}subject:job:demo:${RUN}-timeout`);
    expect(subject).toMatchObject({ reservedMicroUsd: 0, spentMicroUsd: call!.reservedMicroUsd });
  });

  it('recovers only stale pending rows, without resending them', async () => {
    const old = new Date(Date.now() - 60 * 60 * 1000);
    const [stale] = await db
      .insert(skillAssessments)
      .values({
        kind: 'job',
        subjectKind: 'demo',
        subjectKey: `${RUN}-stale`,
        cacheKey: `${RUN}-stale`,
        model: 'muse-spark-1.3',
        catalogueVersion: 2,
        status: 'pending',
        startedAt: old,
        heartbeatAt: old,
      })
      .returning();
    const [active] = await db
      .insert(skillAssessments)
      .values({
        kind: 'job',
        subjectKind: 'demo',
        subjectKey: `${RUN}-active`,
        cacheKey: `${RUN}-active`,
        model: 'muse-spark-1.3',
        catalogueVersion: 2,
        status: 'pending',
        startedAt: old,
      })
      .returning();
    const scope = `${NS}stale`;
    await dbLedger(stale!.id, 'muse-spark-1.3', [{ scope, cap: 1000 }], old).reserve(1, 300);

    expect(await recoverStaleAssessments()).toBeGreaterThanOrEqual(1);
    const rows = await db
      .select()
      .from(skillAssessments)
      .where(like(skillAssessments.subjectKey, `${RUN}-%ctive`));
    expect(rows.find((r) => r.id === active!.id)!.status).toBe('pending');
    const [recovered] = await db
      .select()
      .from(skillAssessments)
      .where(eq(skillAssessments.id, stale!.id));
    expect(recovered).toMatchObject({ status: 'failed', errorCode: 'interrupted' });
    expect(await budget(scope)).toMatchObject({ reservedMicroUsd: 0, spentMicroUsd: 300 });
  });

  it('rolls back the whole recovery when settling a reservation fails', async () => {
    const old = new Date(Date.now() - 60 * 60 * 1000);
    const [stale] = await db
      .insert(skillAssessments)
      .values({
        kind: 'job',
        subjectKind: 'demo',
        subjectKey: `${RUN}-atomic`,
        cacheKey: `${RUN}-atomic`,
        model: 'muse-spark-1.3',
        catalogueVersion: 2,
        status: 'pending',
        startedAt: old,
        heartbeatAt: old,
      })
      .returning();
    const scope = `${NS}atomic`;
    await db.insert(museSpendBudgets).values({ scope, capMicroUsd: 1000, reservedMicroUsd: 100 });
    // Releasing 500 from a scope holding 100 violates the non-negative check mid-transaction.
    await db.insert(museCalls).values({
      assessmentId: stale!.id,
      model: 'muse-spark-1.3',
      attempt: 1,
      scopes: [scope],
      settlement: 'reserved',
      reservedMicroUsd: 500,
    });

    await expect(recoverStaleAssessments()).rejects.toThrow();
    const [row] = await db
      .select()
      .from(skillAssessments)
      .where(eq(skillAssessments.id, stale!.id));
    const [call] = await db.select().from(museCalls).where(eq(museCalls.assessmentId, stale!.id));
    expect(row!.status).toBe('pending');
    expect(call!.settlement).toBe('reserved');
    expect(await budget(scope)).toMatchObject({ reservedMicroUsd: 100, spentMicroUsd: 0 });
    await db.delete(skillAssessments).where(eq(skillAssessments.id, stale!.id));
  });

  it('lets only the current run reserve or save after a recovery and retry', async () => {
    let release!: () => void;
    let started!: () => void;
    const fetchStarted = new Promise<void>((r) => (started = r));
    const stalled = fakeFetch(
      () =>
        new Promise((resolve) => {
          started();
          release = () => resolve(completion(JOB_OUTPUT));
        }),
    );
    const first = analyzeJob(job('stalled'), { ...OPTIONS, fetch: stalled as never });
    await fetchStarted;

    // The runner stalls past the stale threshold; recovery fails its row and settles its call.
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await db
      .update(skillAssessments)
      .set({ heartbeatAt: old })
      .where(eq(skillAssessments.subjectKey, `${RUN}-stalled`));
    const [before] = await db
      .select()
      .from(skillAssessments)
      .where(eq(skillAssessments.subjectKey, `${RUN}-stalled`));
    expect(await recoverStaleAssessments()).toBeGreaterThanOrEqual(1);

    const retried = await analyzeJob(job('stalled'), {
      ...OPTIONS,
      retryFailed: true,
      fetch: fakeFetch(completion(JOB_OUTPUT)) as never,
    });
    expect(retried.cached).toBe(false);

    // The old runner can neither reserve again nor overwrite the retry's result.
    await expect(
      dbLedger(
        before!.id,
        'muse-spark-1.3',
        [{ scope: `${NS}x`, cap: 1000 }],
        before!.startedAt,
      ).reserve(2, 1),
    ).rejects.toMatchObject({ code: 'previous_failure' });
    release();
    await expect(first).rejects.toMatchObject({ code: 'previous_failure' });

    // The retry is a new run; the interrupted one stays failed with its estimated spend.
    const [row] = await db
      .select()
      .from(skillAssessments)
      .where(eq(skillAssessments.id, before!.id));
    expect(row).toMatchObject({ status: 'failed', errorCode: 'interrupted' });
    const calls = await db.select().from(museCalls).where(eq(museCalls.assessmentId, before!.id));
    expect(calls.map((c) => c.settlement)).toEqual(['ambiguous']);
    const [retriedRow] = await db
      .select()
      .from(skillAssessments)
      .where(eq(skillAssessments.id, retried.assessmentId));
    expect(retriedRow).toMatchObject({ status: 'complete', errorCode: null });
    const subject = await budget(`${NS}subject:job:demo:${RUN}-stalled`);
    expect(subject!.reservedMicroUsd).toBe(0);
  });

  it('stores attribution gaps and keeps the resulting matches provisional', async () => {
    const fetchMock = fakeFetch(completion(JOB_OUTPUT), completion(CANDIDATE_OUTPUT));
    const options = { ...OPTIONS, fetch: fetchMock as unknown as typeof fetch };
    await analyzeJob(job('gaps'), options);
    const repo = attributedRepo();
    repo.collected.gaps.push({ reason: 'pr_lookup_incomplete', commitSha: 'c1' });
    const subject = { kind: 'demo' as const, key: `${RUN}-gaps` };
    const { assessmentId, assessment } = await analyzeCandidate(
      fixtureCandidate([repo], { subject }),
      options,
    );
    expect(assessment.status).toBe('partial');
    const [row] = await db
      .select()
      .from(skillAssessments)
      .where(eq(skillAssessments.id, assessmentId));
    expect((row!.result as typeof assessment).coverage.attributionGaps).toEqual([
      { repo: 'octo/one', reason: 'pr_lookup_incomplete', commitSha: 'c1', path: null },
    ]);
    expect(await matchSaved(subject, `${RUN}-gaps`)).toMatchObject({
      status: 'scored',
      provisional: true,
    });
  });

  it('matches saved assessments with employer overrides and no further calls', async () => {
    const fetchMock = fakeFetch(completion(JOB_OUTPUT), completion(CANDIDATE_OUTPUT));
    const options = { ...OPTIONS, fetch: fetchMock as unknown as typeof fetch };
    await analyzeJob(job('match'), options);
    const subject = { kind: 'demo' as const, key: `${RUN}-match` };
    await analyzeCandidate(fixtureCandidate([attributedRepo()], { subject }), options);

    await expect(
      setPriorityOverride({ jobKey: `${RUN}-match`, skillId: 'unit-testing', priority: 4 }),
    ).rejects.toThrow(RangeError);
    await setPriorityOverride({ jobKey: `${RUN}-match`, skillId: 'unit-testing', priority: 3 });
    const result = await matchSaved(subject, `${RUN}-match`);
    expect(result).toMatchObject({
      status: 'scored',
      compatibility: 50,
      evidenceCoverage: 100,
      requirements: [{ verdict: 'partly_met', priority: 3, prioritySource: 'override' }],
    });
    expect(chats(fetchMock)).toBe(2);
  });

  it('refuses a user résumé in Contributor mode before claiming, leaving no pending row', async () => {
    const fetchMock = fakeFetch();
    const subject = { kind: 'user' as const, key: `${RUN}-resume` };
    const prepared = fixtureCandidate([attributedRepo()], { subject, resume: { text: 'Resume' } });
    await expect(
      analyzeCandidate(prepared, { ...OPTIONS, fetch: fetchMock as never }),
    ).rejects.toMatchObject({ code: 'contributor_not_permitted' });
    expect(fetchMock).not.toHaveBeenCalled();
    const rows = await db
      .select()
      .from(skillAssessments)
      .where(eq(skillAssessments.cacheKey, keyOf(prepared)));
    expect(rows).toEqual([]);
  });

  it('sends an approved demo resume to Contributor mode as an unverified claim', async () => {
    const fetchMock = fakeFetch(completion(CANDIDATE_OUTPUT));
    const subject = { kind: 'demo' as const, key: `${RUN}-demo-resume` };
    const prepared = fixtureCandidate([attributedRepo()], {
      subject,
      resume: { text: 'Claims Kubernetes expertise' },
    });
    const result = await analyzeCandidate(prepared, { ...OPTIONS, fetch: fetchMock as never });
    expect(result.assessment.status).toBe('complete');
    const chat = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/chat/completions'));
    const sent = JSON.parse((chat as unknown as [string, RequestInit])[1].body as string) as {
      messages: { content: string }[];
    };
    expect(sent.messages[2]!.content).toContain('<resume>\nClaims Kubernetes expertise\n</resume>');
  });

  it('runs a fresh assessment for an explicit regrade of unchanged input', async () => {
    const fetchMock = fakeFetch(
      completion(CANDIDATE_OUTPUT),
      completion(CANDIDATE_OUTPUT),
      completion(JOB_OUTPUT),
      completion(JOB_OUTPUT),
    );
    const options = { ...OPTIONS, fetch: fetchMock as unknown as typeof fetch };
    const subject = { kind: 'demo' as const, key: `${RUN}-regrade` };
    const prepared = fixtureCandidate([attributedRepo()], { subject });
    const first = await analyzeCandidate(prepared, options);
    expect((await analyzeCandidate(prepared, options)).cached).toBe(true);
    const regraded = await analyzeCandidate(prepared, { ...options, fresh: true });
    expect(regraded.cached).toBe(false);
    expect(regraded.assessmentId).not.toBe(first.assessmentId);

    const posting = job('regrade');
    const graded = await analyzeJob(posting, options);
    const again = await analyzeJob(posting, { ...options, fresh: true });
    expect(again).toMatchObject({ cached: false });
    expect(again.assessmentId).not.toBe(graded.assessmentId);
    expect(chats(fetchMock)).toBe(4);

    // The newest saved run is the current one; earlier runs stay as history.
    const lookup = await assessmentByFingerprint('candidate', subject, keyOf(prepared));
    expect(lookup).toMatchObject({ state: 'current' });
    const rows = await db
      .select()
      .from(skillAssessments)
      .where(
        and(eq(skillAssessments.kind, 'candidate'), eq(skillAssessments.subjectKey, subject.key)),
      );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.inputManifest?.repos[0]?.repo === 'octo/one')).toBe(true);
  });

  it('charges each seeker only their own allowance', async () => {
    const fetchMock = fakeFetch(completion(CANDIDATE_OUTPUT));
    const day = new Date().toISOString().slice(0, 10);
    const dailyBefore = await budget(`${NS}daily:${day}`);
    const a = { kind: 'demo' as const, key: `${RUN}-seeker-a` };
    const b = { kind: 'demo' as const, key: `${RUN}-seeker-b` };
    await analyzeCandidate(fixtureCandidate([attributedRepo()], { subject: a }), {
      ...OPTIONS,
      fetch: fetchMock as never,
    });
    const spentA = await budget(`${NS}subject:candidate:demo:${a.key}`);
    expect(spentA).toMatchObject({ capMicroUsd: 15_000_000, reservedMicroUsd: 0 });
    expect(spentA!.spentMicroUsd).toBeGreaterThan(0);
    expect(await budget(`${NS}subject:candidate:demo:${b.key}`)).toBeUndefined();
    // The shared daily cap is never charged for a seeker's run.
    expect(await budget(`${NS}daily:${day}`)).toEqual(dailyBefore);

    // B's allowance is untouched, so B can spend even when A's is exhausted.
    await db
      .update(museSpendBudgets)
      .set({ spentMicroUsd: 15_000_000 })
      .where(eq(museSpendBudgets.scope, `${NS}subject:candidate:demo:${a.key}`));
    const refused = fakeFetch(completion(CANDIDATE_OUTPUT));
    await expect(
      analyzeCandidate(fixtureCandidate([attributedRepo()], { subject: a }), {
        ...OPTIONS,
        fresh: true,
        fetch: refused as never,
      }),
    ).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(chats(refused)).toBe(0);
    const okB = fakeFetch(completion(CANDIDATE_OUTPUT));
    await expect(
      analyzeCandidate(fixtureCandidate([attributedRepo()], { subject: b }), {
        ...OPTIONS,
        fetch: okB as never,
      }),
    ).resolves.toMatchObject({ cached: false });
  });

  it('still saves a no-evidence result with a resume, without any request', async () => {
    const fetchMock = fakeFetch();
    const subject = { kind: 'demo' as const, key: `${RUN}-resume-none` };
    const prepared = fixtureCandidate([unattributedRepo()], {
      subject,
      resume: { text: 'Resume' },
    });
    const result = await analyzeCandidate(prepared, { ...OPTIONS, fetch: fetchMock as never });
    expect(result.assessment.status).toBe('no_attributed_evidence');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('looks results up by exact fingerprint, never returning older inputs as current', async () => {
    const subject = { kind: 'demo' as const, key: `${RUN}-lookup` };
    const first = fixtureCandidate([attributedRepo()], { subject });
    const key = keyOf;
    expect(await assessmentByFingerprint('candidate', subject, key(first))).toEqual({
      state: 'not_started',
    });
    const fetchMock = fakeFetch(completion(CANDIDATE_OUTPUT));
    await analyzeCandidate(first, { ...OPTIONS, fetch: fetchMock as never });
    expect(await assessmentByFingerprint('candidate', subject, key(first))).toMatchObject({
      state: 'current',
      assessment: { subject, status: 'complete' },
    });
    const changed = fixtureCandidate(
      [attributedRepo(), fixtureRepo('three', [{ path: 'x.ts', content: sourceLines(3) }], [])],
      { subject },
    );
    expect(await assessmentByFingerprint('candidate', subject, key(changed))).toEqual({
      state: 'outdated',
    });
    // Another subject's row is never returned for this subject.
    const other = { kind: 'demo' as const, key: `${RUN}-lookup-other` };
    expect(await assessmentByFingerprint('candidate', other, key(first))).toEqual({
      state: 'not_started',
    });
  });
});

const { costMicroUsd, estimateTokens, reservationMicroUsd } = await import('./muse.js');

describe.runIf(up)('input budget and concurrency (Postgres)', () => {
  const MODEL = 'muse-spark-1.3-contributor';
  const counted = (n: number) => new Response(JSON.stringify({ input_tokens: n }), { status: 200 });
  const sentAt = (fetchMock: ReturnType<typeof fakeFetch>, i: number) => {
    const [url, init] = fetchMock.mock.calls[i] as unknown as [string, RequestInit];
    return { url, body: JSON.parse(init.body as string) as Record<string, unknown> };
  };
  const reservedFor = async (assessmentId: string) =>
    (
      await db
        .select({ reserved: museCalls.reservedMicroUsd })
        .from(museCalls)
        .where(eq(museCalls.assessmentId, assessmentId))
    ).map((r) => r.reserved);
  const bigRepo = () =>
    fixtureRepo(
      'big',
      [
        { path: 'src/a.ts', content: sourceLines(30) },
        ...Array.from({ length: 20 }, (_, i) => ({
          path: `src/m${i}.ts`,
          content: sourceLines(120, `m${i}_`),
        })),
      ],
      [{ sha: 'c1', path: 'src/a.ts', start: 1, end: 5 }],
    );

  /** Counts at 0.8x the estimate; answers each part citing the first attributed ref it holds. */
  const splitFetch = (failAt?: number) => {
    let chats = 0;
    return vi.fn(async (url: string, init: RequestInit) => {
      const sent = JSON.parse(init.body as string) as { messages?: { content: string }[] };
      if (url.endsWith('/responses/input_tokens')) {
        return counted(Math.ceil(((init.body as string).length / 3) * 0.8));
      }
      if (++chats === failAt) return new Response('{}', { status: 400 });
      const ref = /<a ref="(a\d+)"/.exec(sent.messages![2]!.content)?.[1];
      return completion(
        ref
          ? {
              ...CANDIDATE_OUTPUT,
              repositories: [
                {
                  ...CANDIDATE_OUTPUT.repositories[0],
                  contribution: { summary: 'Wrote', refs: [ref] },
                },
              ],
              skills: [{ ...CANDIDATE_OUTPUT.skills[0], evidence_refs: [ref] }],
            }
          : { repositories: [], skills: [] },
      );
    });
  };
  const chatBodies = (fetchMock: ReturnType<typeof splitFetch>) =>
    fetchMock.mock.calls
      .filter(([url]) => url.endsWith('/chat/completions'))
      .map(([, init]) => JSON.parse(init.body as string) as { messages: { content: string }[] })
      .map((b) => b.messages[2]!.content);
  const filesIn = (text: string) => [...text.matchAll(/<file path="([^"]+)"/g)].map((m) => m[1]!);

  it('splits evidence over the ceiling across requests, sending every file', async () => {
    const fetchMock = splitFetch();
    const subject = { kind: 'demo' as const, key: `${RUN}-split` };
    const result = await analyzeCandidate(fixtureCandidate([bigRepo()], { subject }), {
      ...OPTIONS,
      inputTokenCeiling: 30_000,
      fetch: fetchMock as never,
    });
    const bodies = chatBodies(fetchMock);
    expect(bodies.length).toBeGreaterThan(1);
    // Nothing truncated: every file is sent, and each request repeats the repository header.
    const sent = bodies.flatMap(filesIn);
    const all = ['src/a.ts', ...Array.from({ length: 20 }, (_, i) => `src/m${i}.ts`)];
    expect(new Set(sent)).toEqual(new Set(all));
    expect(sent).toHaveLength(21);
    bodies.forEach((b, i) => {
      expect(b).toContain(`Request ${i + 1} of ${bodies.length}`);
      expect(b).toContain('<repo ref="r1" name="octo/big"');
    });
    // Each request was counted under the ceiling and reserved at its own count.
    const reserved = await reservedFor(result.assessmentId);
    expect(reserved).toHaveLength(bodies.length);
    const max = reservationMicroUsd(MODEL, 30_008, 32_000);
    for (const r of reserved) expect(r).toBeLessThanOrEqual(max);
    expect(result.assessment).toMatchObject({
      status: 'complete',
      coverage: { evidence: 'complete' },
    });
    expect(result.assessment.skills).toEqual([
      expect.objectContaining({
        skillId: 'unit-testing',
        evidence: [expect.objectContaining({ ref: 'a1' })],
      }),
    ]);
  });

  it('saves processed requests as partial when a later one fails, listing the rest', async () => {
    const fetchMock = splitFetch(2);
    const subject = { kind: 'demo' as const, key: `${RUN}-split-fail` };
    const result = await analyzeCandidate(fixtureCandidate([bigRepo()], { subject }), {
      ...OPTIONS,
      inputTokenCeiling: 30_000,
      fetch: fetchMock as never,
    });
    const bodies = chatBodies(fetchMock);
    expect(bodies).toHaveLength(2);
    const notProcessed = result.assessment.coverage.omissions.filter(
      (o) => o.reason === 'not_processed',
    );
    expect(notProcessed.length).toBeGreaterThan(0);
    for (const o of notProcessed) expect(filesIn(bodies[0]!)).not.toContain(o.path);
    expect(result.assessment).toMatchObject({
      status: 'partial',
      coverage: { evidence: 'sampled' },
    });
    expect(result.assessment.skills[0]).toMatchObject({
      skillId: 'unit-testing',
      attributionLimitations: expect.arrayContaining(['sampled_evidence']),
    });
  });

  it('never sends a request it could not count: bounded retries, then a retryable failure', async () => {
    const outcomes: unknown[] = [];
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/responses/input_tokens')
        ? new Response('{}', { status: 503 })
        : completion(CANDIDATE_OUTPUT),
    );
    const subject = { kind: 'demo' as const, key: `${RUN}-uncounted` };
    await expect(
      analyzeCandidate(fixtureCandidate([attributedRepo()], { subject }), {
        ...OPTIONS,
        fetch: fetchMock as never,
        onCount: (o) => outcomes.push(o),
      }),
    ).rejects.toMatchObject({ code: 'count_unavailable' });
    // Three counting attempts, no paid request, no saved row; only the outcome is reported.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(chats(fetchMock)).toBe(0);
    expect(outcomes).toEqual([
      { outcome: 'failed', failure: 'http_5xx', attempts: 3, latencyMs: expect.any(Number) },
    ]);
    const rows = await db
      .select()
      .from(skillAssessments)
      .where(eq(skillAssessments.subjectKey, subject.key));
    expect(rows).toEqual([]);
  });

  it('grades seekers concurrently, one run per subject, each on their own allowance', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let inFlight = 0;
    let peak = 0;
    const fetchMock = vi.fn(async () => {
      peak = Math.max(peak, ++inFlight);
      await gate;
      inFlight--;
      return completion(CANDIDATE_OUTPUT);
    });
    const subjects = ['para-a', 'para-b'].map((s) => ({
      kind: 'demo' as const,
      key: `${RUN}-${s}`,
    }));
    const options = { ...OPTIONS, fetch: withCounts(fetchMock as never) };
    const runs = subjects.map((subject) =>
      analyzeCandidate(fixtureCandidate([attributedRepo()], { subject }), options),
    );
    await vi.waitFor(() => expect(peak).toBe(2));
    await expect(
      analyzeCandidate(fixtureCandidate([attributedRepo()], { subject: subjects[0] }), {
        ...options,
        fresh: true,
      }),
    ).rejects.toMatchObject({ code: 'in_progress' });
    release();
    await Promise.all(runs);
    const cost = costMicroUsd(MODEL, {
      promptTokens: 1000,
      cachedTokens: 0,
      completionTokens: 100,
      reasoningTokens: 0,
    });
    for (const s of subjects) {
      expect(await budget(`${NS}subject:candidate:demo:${s.key}`)).toMatchObject({
        reservedMicroUsd: 0,
        spentMicroUsd: cost,
      });
    }
  });
});
