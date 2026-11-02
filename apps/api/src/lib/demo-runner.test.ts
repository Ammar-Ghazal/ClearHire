import { randomUUID } from 'node:crypto';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureCandidate, fixtureRepo, sourceLines } from './candidate-fixtures.js';
import type { PreparedCandidate } from './candidate-evidence.js';

// Real Postgres; GitHub and Muse are mocked. Configuration is mutable so a test can unset it.
const config = vi.hoisted(() => ({
  META_API_KEY: 'test-key' as string | undefined,
  META_MODEL: 'muse-spark-1.3' as string | undefined,
}));
vi.mock('../env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../env.js')>();
  const env = new Proxy(actual.env, {
    get: (target, prop) =>
      prop in config ? config[prop as keyof typeof config] : target[prop as keyof typeof target],
  });
  return { ...actual, env };
});

const fetched: string[] = [];
let gate: Promise<void> | null = null;
vi.mock('./ingest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ingest.js')>();
  return {
    ...actual,
    ingestRepo: vi.fn(async (_o: unknown, { repo }: { repo: string }) => {
      fetched.push(repo);
      if (gate) await gate;
      return fixtureRepo(repo, [{ path: 'src/b.ts', content: sourceLines(5) }], []).snapshot;
    }),
  };
});
vi.mock('./contributions.js', () => ({
  collectContributions: vi.fn(
    async (_o: unknown, { repo }: { repo: string }) => fixtureRepo(repo, [], []).collected,
  ),
}));

const { db, databaseIsUp, pool } = await import('../db/client.js');
const schema = await import('../db/schema.js');
const {
  demoCandidates,
  demoEmployers,
  demoJobs,
  jobPriorityOverrides,
  museCalls,
  museSpendBudgets,
  skillAssessments,
} = schema;
const { serializePreparedCandidate } = await import('./candidate-evidence.js');
const { setPriorityOverride } = await import('./assessments.js');
const { RunError, startCandidateRun, startJobRun } = await import('./demo-runner.js');
const { candidateState, demoMatch, jobState } = await import('./demo-results.js');

const RUN = `test-${randomUUID()}`;
const NS = `${RUN}:`;
const up = await databaseIsUp();
const EMPLOYER = `${RUN}-acme`;

const CANDIDATE_OUTPUT = {
  repositories: [
    {
      repo: 'r1',
      functionality: [{ summary: 'Exports constants', refs: ['c1'] }],
      quality_observations: [],
      limitations: [],
      contribution: { summary: 'Wrote the module', refs: ['a1'] },
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
const JOB_OUTPUT = {
  in_scope: true,
  out_of_scope_reason: null,
  requirements: [
    { skill_id: 'unit-testing', required_level: 2, suggested_priority: 2, refs: ['j1'] },
    { skill_id: 'api-design', required_level: 1, suggested_priority: 1, refs: ['j1'] },
  ],
  eligibility_constraints: [],
  supporting_tags: [],
};

function completion(content: unknown) {
  return new Response(
    JSON.stringify({
      id: 'resp',
      choices: [
        { finish_reason: 'stop', message: { content: JSON.stringify(content), refusal: null } },
      ],
      usage: { prompt_tokens: 1000, completion_tokens: 100 },
    }),
    { status: 200 },
  );
}
const museFetch = (...outputs: unknown[]) =>
  vi.fn(async () => {
    const next = outputs.shift();
    if (next === undefined) throw new Error('Unexpected Muse request');
    return completion(next);
  });

const attributed = (name: string) =>
  fixtureRepo(
    name,
    [{ path: 'src/a.ts', content: sourceLines(30) }],
    [{ sha: `${name}-c1`, path: 'src/a.ts', start: 1, end: 5 }],
  );
const sel = (name: string) => ({ owner: 'octo', repo: name, pinnedSha: `snap-${name}` });

async function seedCandidate(
  suffix: string,
  opts: {
    repos?: PreparedCandidate['repos'];
    selected?: string[];
    resume?: string;
    organization?: boolean;
  } = {},
) {
  const key = `${RUN}-${suffix}`;
  const prepared = fixtureCandidate(opts.repos ?? [attributed('one')], {
    subject: { kind: 'demo', key },
  });
  const serialized = serializePreparedCandidate(prepared);
  await db.insert(demoCandidates).values({
    key,
    name: suffix,
    githubUrl: 'https://github.com/cand',
    githubLogin: 'cand',
    organization: opts.organization ?? false,
    repositories: (opts.selected ?? ['one']).map(sel),
    verification: {},
    raw: {},
    profileSha256: 'p',
    prepared: JSON.parse(serialized),
    preparedSha256: 'x',
    ...(opts.resume && { resumeStatus: 'extracted' as const, resumeText: opts.resume }),
  });
  return key;
}

async function seedJob(suffix: string, inScope = true) {
  const id = `${RUN}-${suffix}`;
  await db.insert(demoJobs).values({
    id,
    employerId: EMPLOYER,
    title: 'Engineer',
    sourceUrl: 'https://acme.test',
    scenario: inScope ? 'possible_skill_overlap' : 'out_of_scope_negative_control',
    inScope,
    text: 'Write unit tests and design APIs',
    textSource: 'fixture_summary',
    raw: {},
    recordSha256: 'r',
    inputSha256: 'i',
  });
  return id;
}

const candidate = async (key: string) =>
  (await db.select().from(demoCandidates).where(eq(demoCandidates.key, key)))[0]!;
const job = async (id: string) => (await db.select().from(demoJobs).where(eq(demoJobs.id, id)))[0]!;
const options = (fetchMock: ReturnType<typeof museFetch>) => ({
  runOptions: {
    budgetNamespace: NS,
    sleep: async () => {},
    fetch: fetchMock as unknown as typeof fetch,
  },
});
const paidCalls = async () =>
  (
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(museCalls)
      .innerJoin(skillAssessments, eq(museCalls.assessmentId, skillAssessments.id))
      .where(like(skillAssessments.subjectKey, `${RUN}%`))
  )[0]!.n;

beforeEach(() => {
  fetched.length = 0;
  gate = null;
  config.META_API_KEY = 'test-key';
  config.META_MODEL = 'muse-spark-1.3';
});

afterAll(async () => {
  if (up) {
    await db.delete(skillAssessments).where(like(skillAssessments.subjectKey, `${RUN}%`));
    await db.delete(museSpendBudgets).where(like(museSpendBudgets.scope, `${NS}%`));
    await db.delete(jobPriorityOverrides).where(like(jobPriorityOverrides.jobKey, `${RUN}%`));
    await db.delete(demoJobs).where(like(demoJobs.id, `${RUN}%`));
    await db.delete(demoEmployers).where(like(demoEmployers.id, `${RUN}%`));
    await db.delete(demoCandidates).where(like(demoCandidates.key, `${RUN}%`));
  }
  await pool.end();
});

describe.runIf(up)('demo runner (Postgres)', () => {
  it('seeds an employer', async () => {
    await db.insert(demoEmployers).values({
      id: EMPLOYER,
      name: 'Acme',
      description: 'Tools',
      url: 'https://acme.test',
      raw: {},
      recordSha256: 'e',
    });
  });

  it('reuses a valid preparation, completes cleanly, then serves the cached result', async () => {
    const key = await seedCandidate('reuse');
    const fetchMock = museFetch(CANDIDATE_OUTPUT);
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const run = await startCandidateRun(key, { retry: false }, options(fetchMock));
    expect(run.result).toBe('started');
    await run.done;
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
    expect(fetched).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await candidate(key)).toMatchObject({ runStatus: 'idle', runError: null });
    expect((await candidateState(await candidate(key))).freshness.state).toBe('current');

    const again = await startCandidateRun(key, { retry: false }, options(fetchMock));
    expect(again).toEqual({ result: 'cached' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fetches only the selection that is missing from the preparation', async () => {
    const key = await seedCandidate('partial', { selected: ['one', 'two'] });
    expect((await candidateState(await candidate(key))).freshness.state).toBe('not_prepared');
    const run = await startCandidateRun(
      key,
      { retry: false },
      options(museFetch(CANDIDATE_OUTPUT)),
    );
    await run.done;
    expect(fetched).toEqual(['two']);
    const state = await candidateState(await candidate(key));
    expect(state.freshness.state).toBe('current');
  });

  it('re-fetches transient GitHub failures on Retry, even when the result is current', async () => {
    const key = await seedCandidate('transient', {
      repos: [
        attributed('one'),
        { owner: 'octo', repo: 'two', unavailable: 'rate_limited', requestedSha: 'snap-two' },
      ],
      selected: ['one', 'two'],
    });
    const fetchMock = museFetch(CANDIDATE_OUTPUT, CANDIDATE_OUTPUT);
    await (
      await startCandidateRun(key, { retry: false }, options(fetchMock))
    ).done;
    expect(fetched).toEqual([]);
    expect(await startCandidateRun(key, { retry: false }, options(fetchMock))).toEqual({
      result: 'cached',
    });
    const retried = await startCandidateRun(key, { retry: true }, options(fetchMock));
    expect(retried.result).toBe('started');
    await retried.done;
    expect(fetched).toEqual(['two']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('starts one run for concurrent requests', async () => {
    const key = await seedCandidate('concurrent');
    const fetchMock = museFetch(CANDIDATE_OUTPUT);
    const results = await Promise.allSettled([
      startCandidateRun(key, { retry: false }, options(fetchMock)),
      startCandidateRun(key, { retry: false }, options(fetchMock)),
    ]);
    const started = results.filter((r) => r.status === 'fulfilled');
    expect(started).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'in_progress' },
    });
    await (started[0] as PromiseFulfilledResult<{ done?: Promise<void> }>).value.done;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('recovers a stale run on the next start; only Retry restarts it', async () => {
    const key = await seedCandidate('stale');
    await db
      .update(demoCandidates)
      .set({
        runStatus: 'pending',
        runId: randomUUID(),
        runHeartbeatAt: new Date(Date.now() - 600_000),
      })
      .where(eq(demoCandidates.key, key));
    const fetchMock = museFetch(CANDIDATE_OUTPUT);
    await expect(
      startCandidateRun(key, { retry: false }, options(fetchMock)),
    ).rejects.toMatchObject({
      code: 'previous_failure',
    });
    expect(await candidate(key)).toMatchObject({ runStatus: 'failed', runError: 'interrupted' });
    await (
      await startCandidateRun(key, { retry: true }, options(fetchMock))
    ).done;
    expect(await candidate(key)).toMatchObject({ runStatus: 'idle', runError: null });
  });

  it('a worker that lost its claim writes nothing and never starts a paid request', async () => {
    const key = await seedCandidate('superseded', { selected: ['one', 'two'] });
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    const fetchMock = museFetch(CANDIDATE_OUTPUT);
    const run = await startCandidateRun(key, { retry: false }, options(fetchMock));
    await vi.waitFor(() => expect(fetched).toEqual(['two']));
    // Recovery and a newer claim replace the token while the old worker is still fetching.
    const newer = randomUUID();
    await db
      .update(demoCandidates)
      .set({ runId: newer, runStatus: 'pending', runHeartbeatAt: new Date() })
      .where(eq(demoCandidates.key, key));
    const before = (await candidate(key)).prepared;
    release();
    await run.done;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await candidate(key)).toMatchObject({
      runId: newer,
      runStatus: 'pending',
      prepared: before,
    });
    await db
      .update(demoCandidates)
      .set({ runStatus: 'idle', runId: null })
      .where(eq(demoCandidates.key, key));
  });

  it('records a Contributor-mode resume refusal as a safe failure, without a request', async () => {
    const key = await seedCandidate('contributor', { resume: 'Claims everything' });
    const fetchMock = museFetch(CANDIDATE_OUTPUT);
    const deps = options(fetchMock);
    const run = await startCandidateRun(
      key,
      { retry: false },
      {
        ...deps,
        runOptions: { ...deps.runOptions, model: 'muse-spark-1.3-contributor' },
      },
    );
    await run.done;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await candidate(key)).toMatchObject({
      runStatus: 'failed',
      runError: 'contributor_not_permitted',
    });
  });

  it('refuses subjects that cannot be analysed, and missing configuration', async () => {
    const org = await seedCandidate('org', { organization: true });
    const none = await seedCandidate('none', { selected: [] });
    const outside = await seedJob('outside', false);
    const fetchMock = museFetch();
    await expect(
      startCandidateRun(org, { retry: false }, options(fetchMock)),
    ).rejects.toMatchObject({
      code: 'organization_account',
    });
    await expect(
      startCandidateRun(none, { retry: false }, options(fetchMock)),
    ).rejects.toMatchObject({
      code: 'no_selected_repositories',
    });
    await expect(startJobRun(outside, { retry: false }, options(fetchMock))).rejects.toMatchObject({
      code: 'out_of_scope',
    });
    await expect(startCandidateRun(`${RUN}-missing`, { retry: false })).rejects.toBeInstanceOf(
      RunError,
    );
    config.META_API_KEY = undefined;
    const key = await seedCandidate('unconfigured');
    await expect(
      startCandidateRun(key, { retry: false }, options(fetchMock)),
    ).rejects.toMatchObject({
      code: 'model_not_configured',
    });
    config.META_MODEL = undefined;
    // Reads still work without Muse settings; they just cannot tell whether a result is current.
    expect((await candidateState(await candidate(key))).freshness.state).toBe(
      'model_not_configured',
    );
  });

  it('scores current results, rescores priority changes for free and hides stale ones', async () => {
    const key = await seedCandidate('match');
    const id = await seedJob('match');
    const fetchMock = museFetch(CANDIDATE_OUTPUT, JOB_OUTPUT);
    await (
      await startCandidateRun(key, { retry: false }, options(fetchMock))
    ).done;
    await (
      await startJobRun(id, { retry: false }, options(fetchMock))
    ).done;
    expect((await jobState(await job(id))).freshness.state).toBe('current');
    expect(await startJobRun(id, { retry: false }, options(fetchMock))).toEqual({
      result: 'cached',
    });

    const calls = await paidCalls();
    const first = await demoMatch(await candidate(key), await job(id));
    expect(first).toMatchObject({
      availability: 'available',
      match: { status: 'scored', provisional: true },
    });
    const score = (m: typeof first) =>
      m.availability === 'available' && m.match.status === 'scored' ? m.match.compatibility : null;
    expect(score(first)).toBeCloseTo(100 / 3);
    await setPriorityOverride({ jobKey: id, skillId: 'api-design', priority: 0 });
    expect(score(await demoMatch(await candidate(key), await job(id)))).toBe(50);
    expect(await paidCalls()).toBe(calls);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Input changes hide the old result immediately, before anyone clicks Analyze.
    await db
      .update(demoCandidates)
      .set({ resumeStatus: 'extracted', resumeText: 'New resume' })
      .where(eq(demoCandidates.key, key));
    expect((await candidateState(await candidate(key))).freshness.state).toBe('outdated');
    expect(await demoMatch(await candidate(key), await job(id))).toEqual({
      availability: 'unavailable',
      reason: 'candidate_not_current',
    });
    await db
      .update(demoCandidates)
      .set({
        resumeText: null,
        resumeStatus: 'none',
        repositories: [{ ...sel('one'), pinnedSha: 'other' }],
      })
      .where(eq(demoCandidates.key, key));
    expect((await candidateState(await candidate(key))).freshness.state).toBe('not_prepared');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never scores a candidate without attributed evidence', async () => {
    const key = await seedCandidate('no-evidence', {
      repos: [fixtureRepo('one', [{ path: 'src/a.ts', content: sourceLines(5) }], [])],
    });
    const id = await seedJob('no-evidence');
    const fetchMock = museFetch(JOB_OUTPUT);
    await (
      await startCandidateRun(key, { retry: false }, options(fetchMock))
    ).done;
    await (
      await startJobRun(id, { retry: false }, options(fetchMock))
    ).done;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await demoMatch(await candidate(key), await job(id))).toEqual({
      availability: 'unavailable',
      reason: 'no_attributed_evidence',
    });
    const rows = await db
      .select({ status: skillAssessments.status })
      .from(skillAssessments)
      .where(
        and(eq(skillAssessments.subjectKey, key), inArray(skillAssessments.kind, ['candidate'])),
      );
    expect(rows).toEqual([{ status: 'no_attributed_evidence' }]);
  });
});
