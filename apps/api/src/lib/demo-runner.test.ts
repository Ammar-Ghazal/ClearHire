import type { Octokit } from '@octokit/rest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureRepo, sourceLines } from './candidate-fixtures.js';

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

// Repository code that must never be persisted anywhere.
const SENTINEL = 'const CLEARHIRE_SENTINEL = "this repository line must never be stored";';
/** `plain-*` repositories have no lines attributed to the candidate. */
const repoFixture = (repo: string) =>
  fixtureRepo(
    repo,
    [{ path: 'src/a.ts', content: `${SENTINEL}\n${sourceLines(29)}` }],
    repo.startsWith('plain') ? [] : [{ sha: `${repo}-c1`, path: 'src/a.ts', start: 1, end: 5 }],
  );

const fetched: { repo: string; ref?: string }[] = [];
let gate: Promise<void> | null = null;
vi.mock('./ingest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ingest.js')>();
  return {
    ...actual,
    ingestRepo: vi.fn(async (_o: unknown, { repo, ref }: { repo: string; ref?: string }) => {
      fetched.push({ repo, ref });
      if (gate) await gate;
      return repoFixture(repo).snapshot;
    }),
  };
});
vi.mock('./contributions.js', () => ({
  collectContributions: vi.fn(
    async (_o: unknown, { repo }: { repo: string }) => repoFixture(repo).collected,
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
const { setPriorityOverride } = await import('./assessments.js');
const { analysisTick, drainQueue, RunError, startCandidateRun, startJobRun } = await import(
  './demo-runner.js'
);
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
      // A model quoting source: the line is removed before anything is stored.
      justification: `Tests, as in ${SENTINEL}`,
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
/** Answers each request by its kind, so call order between subjects does not matter. */
const museFetch = (limit = Infinity) => {
  let calls = 0;
  return vi.fn(async (_url: string, init: RequestInit) => {
    if (++calls > limit) throw new Error('Unexpected Muse request');
    const body = JSON.parse(init.body as string) as { response_format: { json_schema: { name: string } } };
    return completion(
      body.response_format.json_schema.name === 'job_assessment' ? JOB_OUTPUT : CANDIDATE_OUTPUT,
    );
  });
};

const octokit = (type = 'User') =>
  ({
    rest: {
      users: {
        getByUsername: vi.fn(async () => ({ data: { id: 101, login: 'cand', type } })),
      },
    },
  }) as unknown as Octokit;
const sel = (name: string) => ({ owner: 'octo', repo: name, pinnedSha: `pin-${name}` });

async function seedCandidate(
  suffix: string,
  opts: { selected?: string[]; resume?: string; organization?: boolean } = {},
) {
  const key = `${RUN}-${suffix}`;
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
    ...(opts.resume && { resumeStatus: 'extracted' as const, resumeText: opts.resume }),
  });
  return key;
}

async function seedJob(
  suffix: string,
  opts: { inScope?: boolean; textSource?: 'full_description' | 'fixture_summary' } = {},
) {
  const id = `${RUN}-${suffix}`;
  const inScope = opts.inScope ?? true;
  await db.insert(demoJobs).values({
    id,
    employerId: EMPLOYER,
    title: 'Engineer',
    sourceUrl: 'https://acme.test',
    scenario: inScope ? 'possible_skill_overlap' : 'out_of_scope_negative_control',
    inScope,
    text: `Write unit tests and design APIs (${suffix})`,
    textSource: opts.textSource ?? 'full_description',
    raw: {},
    recordSha256: 'r',
    inputSha256: 'i',
  });
  return id;
}

const candidate = async (key: string) =>
  (await db.select().from(demoCandidates).where(eq(demoCandidates.key, key)))[0]!;
const job = async (id: string) => (await db.select().from(demoJobs).where(eq(demoJobs.id, id)))[0]!;
const deps = (fetchMock: ReturnType<typeof museFetch>, type?: string) => ({
  octokit: () => octokit(type),
  scope: RUN,
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
const runs = async (key: string) =>
  db
    .select()
    .from(skillAssessments)
    .where(and(eq(skillAssessments.kind, 'candidate'), eq(skillAssessments.subjectKey, key)));

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

  it('fetches every selection at its default-branch head, grades it, then serves the result', async () => {
    const key = await seedCandidate('live', { selected: ['one', 'two'] });
    const fetchMock = museFetch();
    const run = await startCandidateRun(key, { retry: false }, deps(fetchMock));
    expect(run.result).toBe('started');
    await run.done;
    expect(fetched).toEqual([
      { repo: 'one', ref: undefined },
      { repo: 'two', ref: undefined },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await candidate(key)).toMatchObject({ runStatus: 'idle', runError: null });
    const state = await candidateState(await candidate(key));
    expect(state.freshness.state).toBe('current');
    expect(state.assessment!.skills.map((s) => s.skillId)).toEqual(['unit-testing']);
    expect(state.manifest).toEqual({
      repos: [
        { repo: 'octo/one', commitSha: 'snap-one', unavailable: null },
        { repo: 'octo/two', commitSha: 'snap-two', unavailable: null },
      ],
      resumeSha256: null,
    });

    expect(await startCandidateRun(key, { retry: false }, deps(fetchMock))).toEqual({
      result: 'cached',
    });
    expect(fetched).toHaveLength(2);
  });

  it('never persists repository code, in any table', async () => {
    const tables = [
      'demo_candidates',
      'demo_jobs',
      'skill_assessments',
      'muse_calls',
      'muse_spend_budgets',
    ];
    for (const table of tables) {
      const [row] = await db.execute<{ n: number }>(
        sql.raw(
          `select count(*)::int as n from ${table} t where row_to_json(t)::text like '%CLEARHIRE_SENTINEL%'`,
        ),
      ).then((r) => r.rows);
      expect({ table, found: row!.n }).toEqual({ table, found: 0 });
    }
    const [result] = await runs(`${RUN}-live`);
    expect(JSON.stringify(result!.result)).toContain('[source excerpt removed]');
  });

  it('regrades fresh on explicit request: fetches the code again and makes a new call', async () => {
    const key = await seedCandidate('regrade');
    const fetchMock = museFetch();
    await (await startCandidateRun(key, { retry: false }, deps(fetchMock))).done;
    const regrade = await startCandidateRun(key, { retry: true, fresh: true }, deps(fetchMock));
    expect(regrade.result).toBe('started');
    await regrade.done;
    expect(fetched.map((f) => f.repo)).toEqual(['one', 'one']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await runs(key)).toHaveLength(2);

    const id = await seedJob('regrade');
    await (await startJobRun(id, { retry: false }, deps(fetchMock))).done;
    expect(await startJobRun(id, { retry: false }, deps(fetchMock))).toEqual({ result: 'cached' });
    await (await startJobRun(id, { retry: false, fresh: true }, deps(fetchMock))).done;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('starts one run for concurrent requests', async () => {
    const key = await seedCandidate('concurrent');
    const fetchMock = museFetch();
    // The first run holds at the fetch, so the two requests always overlap.
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    const results = await Promise.allSettled([
      startCandidateRun(key, { retry: true, fresh: true }, deps(fetchMock)),
      startCandidateRun(key, { retry: true, fresh: true }, deps(fetchMock)),
    ]);
    release();
    const started = results.filter((r) => r.status === 'fulfilled');
    expect(started).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'in_progress' },
    });
    await (started[0] as PromiseFulfilledResult<{ done?: Promise<void> }>).value.done;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('recovers a stale run on the next start; only a retry restarts it', async () => {
    const key = await seedCandidate('stale');
    await db
      .update(demoCandidates)
      .set({
        runStatus: 'pending',
        runId: randomUUID(),
        runHeartbeatAt: new Date(Date.now() - 600_000),
      })
      .where(eq(demoCandidates.key, key));
    const fetchMock = museFetch();
    await expect(startCandidateRun(key, { retry: false }, deps(fetchMock))).rejects.toMatchObject({
      code: 'previous_failure',
    });
    expect(await candidate(key)).toMatchObject({ runStatus: 'failed', runError: 'interrupted' });
    await (await startCandidateRun(key, { retry: true }, deps(fetchMock))).done;
    expect(await candidate(key)).toMatchObject({ runStatus: 'idle', runError: null });
  });

  it('a worker that lost its claim never starts a paid request', async () => {
    const key = await seedCandidate('superseded');
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    const fetchMock = museFetch();
    const run = await startCandidateRun(key, { retry: false }, deps(fetchMock));
    await vi.waitFor(() => expect(fetched.map((f) => f.repo)).toEqual(['one']));
    // Recovery and a newer claim replace the token while the old worker is still fetching.
    const newer = randomUUID();
    await db
      .update(demoCandidates)
      .set({ runId: newer, runStatus: 'pending', runHeartbeatAt: new Date() })
      .where(eq(demoCandidates.key, key));
    release();
    await run.done;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await candidate(key)).toMatchObject({ runId: newer, runStatus: 'pending' });
    expect(await runs(key)).toEqual([]);
    await db
      .update(demoCandidates)
      .set({ runStatus: 'idle', runId: null })
      .where(eq(demoCandidates.key, key));
  });

  it('sends the approved demo resume to Contributor mode', async () => {
    const key = await seedCandidate('contributor', { resume: 'Claims everything' });
    const fetchMock = museFetch();
    const d = deps(fetchMock);
    const run = await startCandidateRun(
      key,
      { retry: false },
      { ...d, runOptions: { ...d.runOptions, model: 'muse-spark-1.3-contributor' } },
    );
    await run.done;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await candidate(key)).toMatchObject({ runStatus: 'idle', runError: null });
  });

  it('refuses subjects that cannot be analysed, and missing configuration', async () => {
    const org = await seedCandidate('org', { organization: true });
    const none = await seedCandidate('none', { selected: [] });
    const outside = await seedJob('outside', { inScope: false });
    const fetchMock = museFetch(0);
    await expect(startCandidateRun(org, { retry: false }, deps(fetchMock))).rejects.toMatchObject({
      code: 'organization_account',
    });
    await expect(
      startCandidateRun(none, { retry: false }, deps(fetchMock)),
    ).rejects.toMatchObject({ code: 'no_selected_repositories' });
    await expect(startJobRun(outside, { retry: false }, deps(fetchMock))).rejects.toMatchObject({
      code: 'out_of_scope',
    });
    await expect(startCandidateRun(`${RUN}-missing`, { retry: false })).rejects.toBeInstanceOf(
      RunError,
    );
    // An account GitHub reports as an organization fails before any request.
    const lab = await seedCandidate('lab');
    await (await startCandidateRun(lab, { retry: false }, deps(fetchMock, 'Organization'))).done;
    expect(await candidate(lab)).toMatchObject({
      runStatus: 'failed',
      runError: 'organization_account',
    });
    config.META_API_KEY = undefined;
    const key = await seedCandidate('unconfigured');
    await expect(startCandidateRun(key, { retry: false }, deps(fetchMock))).rejects.toMatchObject({
      code: 'model_not_configured',
    });
    config.META_MODEL = undefined;
    // Reads still work without Muse settings; they just cannot tell whether a result is current.
    expect((await candidateState(await candidate(key))).freshness.state).toBe(
      'model_not_configured',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('scores current results, rescores priority changes for free and hides stale ones', async () => {
    const key = await seedCandidate('match');
    const id = await seedJob('match');
    const fetchMock = museFetch();
    await (await startCandidateRun(key, { retry: false }, deps(fetchMock))).done;
    await (await startJobRun(id, { retry: false }, deps(fetchMock))).done;
    expect((await jobState(await job(id))).freshness.state).toBe('current');

    const calls = await paidCalls();
    const first = await demoMatch(await candidate(key), await job(id));
    // Graded from the full posting text, so the score is not provisional.
    expect(first).toMatchObject({
      availability: 'available',
      match: { status: 'scored', provisional: false },
    });
    const score = (m: typeof first) =>
      m.availability === 'available' && m.match.status === 'scored' ? m.match.compatibility : null;
    expect(score(first)).toBeCloseTo(100 / 3);
    await setPriorityOverride({ jobKey: id, skillId: 'api-design', priority: 0 });
    expect(score(await demoMatch(await candidate(key), await job(id)))).toBe(50);
    expect(await paidCalls()).toBe(calls);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Input changes hide the old result immediately, before anyone regrades.
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
      .set({ resumeText: null, resumeStatus: 'none', repositories: [sel('one'), sel('two')] })
      .where(eq(demoCandidates.key, key));
    expect((await candidateState(await candidate(key))).freshness.state).toBe('outdated');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never scores a candidate without attributed evidence', async () => {
    const key = await seedCandidate('no-evidence', { selected: ['plain'] });
    const id = await seedJob('no-evidence');
    const fetchMock = museFetch();
    await (await startCandidateRun(key, { retry: false }, deps(fetchMock))).done;
    await (await startJobRun(id, { retry: false }, deps(fetchMock))).done;
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

describe.runIf(up)('analysis worker (Postgres)', () => {
  const W = `${RUN}-w`;

  it('grades each ungraded subject once, then scores every pair without further calls', async () => {
    const scope = `${W}-`;
    const seekers = await Promise.all(['a', 'b'].map((s) => seedCandidate(`w-${s}`)));
    const jobs = await Promise.all(['x', 'y'].map((s) => seedJob(`w-${s}`)));
    const skipped = {
      org: await seedCandidate('w-org', { organization: true }),
      incomplete: await seedCandidate('w-incomplete', { selected: [] }),
      notes: await seedJob('w-notes', { textSource: 'fixture_summary' }),
      outside: await seedJob('w-outside', { inScope: false }),
    };
    const fetchMock = museFetch();
    const d = { ...deps(fetchMock), scope };
    let ticks = 0;
    while (await analysisTick(d)) ticks++;
    expect(ticks).toBe(4);
    // Two candidates and two jobs: one call each, whatever the number of pairs.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const key of seekers) expect(await candidate(key)).toMatchObject({ runStatus: 'idle' });
    for (const id of jobs) expect(await job(id)).toMatchObject({ runStatus: 'idle' });
    for (const key of [skipped.org, skipped.incomplete]) {
      expect(await candidate(key)).toMatchObject({ runStatus: 'idle' });
      expect(await runs(key)).toEqual([]);
    }
    for (const id of [skipped.notes, skipped.outside]) {
      expect(await job(id)).toMatchObject({ runStatus: 'idle' });
    }

    const before = await paidCalls();
    for (const key of seekers) {
      for (const id of jobs) {
        expect(await demoMatch(await candidate(key), await job(id))).toMatchObject({
          availability: 'available',
          match: { status: 'scored' },
        });
      }
    }
    expect(await paidCalls()).toBe(before);
    // Nothing is queued again once every subject has a result.
    expect(await analysisTick(d)).toBe(false);
  });

  it('never retries a failed subject automatically; grades a legacy result once', async () => {
    const scope = `${W}2-`;
    const failed = await seedCandidate('w2-failed');
    await db
      .update(demoCandidates)
      .set({ runStatus: 'failed', runError: 'timeout' })
      .where(eq(demoCandidates.key, failed));
    const legacy = await seedCandidate('w2-legacy');
    // A saved result from before live analysis: no manifest, so it was never graded live.
    await db.insert(skillAssessments).values({
      kind: 'candidate',
      subjectKind: 'demo',
      subjectKey: legacy,
      cacheKey: 'legacy-key',
      model: 'muse-spark-1.3',
      catalogueVersion: 2,
      status: 'complete',
      result: {},
      completedAt: new Date(),
    });
    const fetchMock = museFetch();
    const d = { ...deps(fetchMock), scope };
    while (await analysisTick(d));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await candidate(failed)).toMatchObject({ runStatus: 'failed', runError: 'timeout' });
    expect((await runs(legacy)).filter((r) => r.inputManifest !== null)).toHaveLength(1);
    expect(await analysisTick(d)).toBe(false);
  });

  it('does nothing without Muse configuration', async () => {
    config.META_API_KEY = undefined;
    const key = await seedCandidate('w3-unconfigured');
    expect(await analysisTick({ ...deps(museFetch(0)), scope: `${W}3-` })).toBe(false);
    expect(await candidate(key)).toMatchObject({ runStatus: 'idle' });
  });
});

describe.runIf(up)('concurrent worker (Postgres)', () => {
  it('grades independent subjects concurrently up to the limit, never one subject twice', async () => {
    const scope = `${RUN}-p4-`;
    const seekers = await Promise.all(['a', 'b', 'c'].map((s) => seedCandidate(`p4-${s}`)));
    const jobs = [await seedJob('p4-x')];
    const answer = museFetch();
    let inFlight = 0;
    let peak = 0;
    let open!: () => void;
    const two = new Promise<void>((resolve) => (open = resolve));
    // Each request waits until two are in flight (or 2s pass), so overlap is deterministic.
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      peak = Math.max(peak, ++inFlight);
      if (inFlight === 2) open();
      await Promise.race([two, new Promise((resolve) => setTimeout(resolve, 2000))]);
      inFlight--;
      return answer(url, init);
    });
    const graded = await drainQueue({ ...deps(fetchMock as never), scope }, 2);
    expect(graded).toBe(4);
    expect(peak).toBe(2);
    expect(answer).toHaveBeenCalledTimes(4);
    for (const key of seekers) expect(await candidate(key)).toMatchObject({ runStatus: 'idle' });
    for (const id of jobs) expect(await job(id)).toMatchObject({ runStatus: 'idle' });
    expect(await drainQueue({ ...deps(museFetch(0)), scope }, 2)).toBe(0);
  });
});
