import { randomUUID } from 'node:crypto';
import { eq, like } from 'drizzle-orm';
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
  candidateFingerprint,
  dbLedger,
  jobFingerprint,
  matchSaved,
  recoverStaleAssessments,
  setPriorityOverride,
} = await import('./assessments.js');
const { fixtureCandidate, fixtureRepo, sourceLines } = await import('./candidate-fixtures.js');

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

function fakeFetch(...responses: (Response | Error | (() => Promise<Response>))[]) {
  return vi.fn(async () => {
    const next = responses.shift() ?? new Error('Unexpected Muse request');
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  });
}

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

// Recorded from the code before fingerprints were extracted (and confirmed equal to the keys it
// stored), so a change here means every saved assessment would silently become outdated. They
// also change when the catalogue or a prompt/schema/cleaner/selection/attribution version does.
const GOLDEN = {
  evidence: 'ef9a60edb1418d4ee8f6e02b6382ae895ccd25aff478146a15684751767acc0d',
  noEvidence: '08176a99b97b875ecddcbf5f92212c962867d6795a28b104280ba8b400874197',
  job: '1f1dda11c327423569dbc547b0b2317699ed8cc328ffcdd41f6aff1f3a4918d3',
};
const golden = (key: string, repos = [attributedRepo()]) =>
  fixtureCandidate(repos, { subject: { kind: 'demo', key } });
const unattributedRepo = () =>
  fixtureRepo('two', [{ path: 'src/b.ts', content: sourceLines(10) }], []);
const MODEL = { model: 'muse-spark-1.3-contributor' as const };

describe('fingerprints', () => {
  it('reproduce the cache keys analysis has always stored', () => {
    expect(candidateFingerprint(golden('golden-evidence'), MODEL).cacheKey).toBe(GOLDEN.evidence);
    const none = candidateFingerprint(golden('golden-none', [unattributedRepo()]), MODEL);
    expect(none).toMatchObject({ noEvidence: true, cacheKey: GOLDEN.noEvidence });
    const posting = { ...job('x'), jobKey: 'golden-job', text: 'Write unit tests' };
    expect(jobFingerprint(posting, MODEL).cacheKey).toBe(GOLDEN.job);
  });

  it('change with resume text only when attributed evidence exists', () => {
    const resume = { text: 'Claims Kubernetes expertise' };
    const withResume = (c: ReturnType<typeof golden>) => ({ ...c, resume });
    const evidence = golden('golden-evidence');
    expect(candidateFingerprint(withResume(evidence), MODEL).cacheKey).not.toBe(GOLDEN.evidence);
    const none = golden('golden-none', [unattributedRepo()]);
    expect(candidateFingerprint(withResume(none), MODEL).cacheKey).toBe(GOLDEN.noEvidence);
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

  it('makes one paid call for concurrent identical requests and caches per model', async () => {
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

    const [row] = await db
      .select()
      .from(skillAssessments)
      .where(eq(skillAssessments.id, before!.id));
    expect(row).toMatchObject({ status: 'complete', errorCode: null });
    const calls = await db.select().from(museCalls).where(eq(museCalls.assessmentId, before!.id));
    expect(calls.map((c) => c.settlement).sort()).toEqual(['ambiguous', 'settled']);
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses resume text in Contributor mode before claiming, leaving no pending row', async () => {
    const fetchMock = fakeFetch();
    const subject = { kind: 'demo' as const, key: `${RUN}-resume` };
    const prepared = fixtureCandidate([attributedRepo()], { subject, resume: { text: 'Resume' } });
    await expect(
      analyzeCandidate(prepared, { ...OPTIONS, fetch: fetchMock as never }),
    ).rejects.toMatchObject({ code: 'contributor_not_permitted' });
    expect(fetchMock).not.toHaveBeenCalled();
    const { cacheKey } = candidateFingerprint(prepared);
    const rows = await db
      .select()
      .from(skillAssessments)
      .where(eq(skillAssessments.cacheKey, cacheKey));
    expect(rows).toEqual([]);
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
    const key = (c: typeof first) => candidateFingerprint(c).cacheKey;
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
