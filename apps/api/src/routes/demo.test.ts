import { randomUUID } from 'node:crypto';
import {
  DemoCandidateListSchema,
  DemoCandidateSchema,
  DemoJobListSchema,
  DemoJobSchema,
  DemoMatchSchema,
} from '@clearhire/shared';
import { eq, like, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureCandidate, fixtureRepo, sourceLines } from '../lib/candidate-fixtures.js';

// Sessions, the allowlist and the runner are mocked; reads use real Postgres where available.
const state = vi.hoisted(() => ({ login: null as string | null, operators: [] as string[] }));
vi.mock('../lib/sessions.js', () => ({ currentUserLogin: vi.fn(async () => state.login) }));
vi.mock('../env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../env.js')>();
  const overrides: Record<string, unknown> = {
    META_API_KEY: 'test-key',
    META_MODEL: 'muse-spark-1.3',
    META_BASE_URL: 'https://muse.test/v1',
  };
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (t, p) => (p in overrides ? overrides[p as string] : t[p as keyof typeof t]),
    }),
    isDemoOperator: (login: string) => state.operators.includes(login.toLowerCase()),
  };
});
vi.mock('./auth.js', () => ({ authRoutes: async () => {} }));
vi.mock('./health.js', () => ({ healthRoutes: async () => {} }));
vi.mock('./me.js', () => ({ meRoutes: async () => {} }));
vi.mock('../lib/demo-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/demo-runner.js')>();
  return { ...actual, startCandidateRun: vi.fn(), startJobRun: vi.fn() };
});

const { buildApp } = await import('../app.js');
const { RunError, startCandidateRun, startJobRun } = await import('../lib/demo-runner.js');
const { db, databaseIsUp, pool } = await import('../db/client.js');
const {
  demoCandidates,
  demoEmployers,
  demoJobs,
  jobPriorityOverrides,
  museCalls,
  museSpendBudgets,
  skillAssessments,
} = await import('../db/schema.js');
const { analyzeCandidate, analyzeJob } = await import('../lib/assessments.js');
const { serializePreparedCandidate } = await import('../lib/candidate-evidence.js');

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
async function app() {
  const instance = await buildApp();
  instance.log.level = 'silent';
  apps.push(instance);
  return instance;
}

const RUN = `test-${randomUUID()}`;
const up = await databaseIsUp();
const spyOnFetch = () => vi.spyOn(globalThis, 'fetch');
let fetchSpy: ReturnType<typeof spyOnFetch>;

beforeEach(() => {
  state.login = null;
  state.operators = [];
  vi.mocked(startCandidateRun).mockReset();
  vi.mocked(startJobRun).mockReset();
  fetchSpy = spyOnFetch();
});
afterEach(async () => {
  fetchSpy.mockRestore();
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

describe('demo mutations: authorization and input', () => {
  const mutations = [
    { method: 'POST' as const, url: '/demo/candidates/c/analysis', payload: {} },
    { method: 'POST' as const, url: '/demo/jobs/j/analysis', payload: {} },
    {
      method: 'PUT' as const,
      url: '/demo/jobs/j/priorities/unit-testing',
      payload: { priority: 2 },
    },
  ];

  it.each(mutations)('$method $url needs a session', async (request) => {
    const res = await (await app()).inject(request);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: 'unauthenticated', message: 'Not signed in' } });
  });

  it.each(mutations)(
    '$method $url needs an allowlisted login, and denies all when unset',
    async (request) => {
      state.login = 'alice';
      expect((await (await app()).inject(request)).statusCode).toBe(403);
      state.operators = ['bob'];
      expect((await (await app()).inject(request)).statusCode).toBe(403);
      expect(startCandidateRun).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['POST', '/demo/candidates/c/analysis', { retry: 'yes' }],
    ['POST', '/demo/candidates/c/analysis', { retry: true, extra: 1 }],
    ['PUT', '/demo/jobs/j/priorities/unit-testing', { priority: 4 }],
    ['PUT', '/demo/jobs/j/priorities/not-a-skill', { priority: 1 }],
  ] as const)('%s %s rejects invalid input %j', async (method, url, payload) => {
    state.login = 'Alice';
    state.operators = ['alice'];
    const res = await (await app()).inject({ method, url, payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_input');
  });

  it('returns 202 only for a started run and 200 for a cached result', async () => {
    state.login = 'alice';
    state.operators = ['alice'];
    vi.mocked(startCandidateRun).mockResolvedValueOnce({
      result: 'started',
      done: Promise.resolve(),
    });
    let res = await (
      await app()
    ).inject({
      method: 'POST',
      url: '/demo/candidates/c/analysis',
      payload: { retry: true },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ result: 'started' });
    expect(vi.mocked(startCandidateRun).mock.calls[0]!.slice(0, 2)).toEqual(['c', { retry: true }]);

    vi.mocked(startJobRun).mockResolvedValueOnce({ result: 'cached' });
    res = await (await app()).inject({ method: 'POST', url: '/demo/jobs/j/analysis' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: 'cached' });
  });

  it('maps runner refusals to 404/409 with safe codes', async () => {
    state.login = 'alice';
    state.operators = ['alice'];
    const instance = await app();
    vi.mocked(startCandidateRun).mockRejectedValueOnce(
      new RunError('in_progress', 'Already running'),
    );
    let res = await instance.inject({ method: 'POST', url: '/demo/candidates/c/analysis' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: { code: 'in_progress', message: 'Already running' } });
    vi.mocked(startJobRun).mockRejectedValueOnce(
      new RunError('not_found', 'No demo job with this id'),
    );
    res = await instance.inject({ method: 'POST', url: '/demo/jobs/j/analysis' });
    expect(res.statusCode).toBe(404);
  });
});

// ---- Reads against real Postgres ----

const KEY = `${RUN}-cand`;
const JOB = `${RUN}-job`;
const OUT = `${RUN}-nurse`;
const EMPLOYER = `${RUN}-acme`;
const SECRET_RESUME = 'Resume text that must never be sent to clients';

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
const reply = (content: unknown) =>
  new Response(
    JSON.stringify({
      id: 'r',
      choices: [
        { finish_reason: 'stop', message: { content: JSON.stringify(content), refusal: null } },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 10 },
    }),
  );
const prepared = fixtureCandidate(
  [
    fixtureRepo(
      'one',
      [{ path: 'src/a.ts', content: sourceLines(30) }],
      [{ sha: 'c1', path: 'src/a.ts', start: 1, end: 5 }],
    ),
  ],
  { subject: { kind: 'demo', key: KEY } },
);
const forbidden = [
  SECRET_RESUME,
  'export const v1',
  '"prepared"',
  '"raw"',
  'resumeText',
  'data/demo',
];

afterAll(async () => {
  if (up) {
    await db.delete(skillAssessments).where(like(skillAssessments.subjectKey, `${RUN}%`));
    await db.delete(museSpendBudgets).where(like(museSpendBudgets.scope, `${RUN}%`));
    await db.delete(jobPriorityOverrides).where(like(jobPriorityOverrides.jobKey, `${RUN}%`));
    await db.delete(demoJobs).where(like(demoJobs.id, `${RUN}%`));
    await db.delete(demoEmployers).where(like(demoEmployers.id, `${RUN}%`));
    await db.delete(demoCandidates).where(like(demoCandidates.key, `${RUN}%`));
  }
  await pool.end();
});

describe.runIf(up)('demo reads (Postgres)', () => {
  it('seeds demo rows', async () => {
    await db.insert(demoEmployers).values({
      id: EMPLOYER,
      name: 'Acme',
      description: 'Tools',
      url: 'https://acme.test',
      raw: { secret: 'raw' },
      recordSha256: 'e',
    });
    const job = {
      employerId: EMPLOYER,
      title: 'Engineer',
      sourceUrl: 'https://acme.test/1',
      text: 'Write unit tests and design APIs',
      textSource: 'fixture_summary' as const,
      raw: {},
      recordSha256: 'r',
      inputSha256: 'i',
    };
    await db.insert(demoJobs).values([
      { ...job, id: JOB, scenario: 'possible_skill_overlap', inScope: true },
      { ...job, id: OUT, scenario: 'out_of_scope_negative_control', inScope: false },
    ]);
    await db.insert(demoCandidates).values({
      key: KEY,
      name: 'Ada',
      githubUrl: 'https://github.com/cand',
      githubLogin: 'cand',
      repositories: [{ owner: 'octo', repo: 'one', pinnedSha: 'snap-one' }],
      verification: {
        identityMatchVerified: false,
        publicRepositoriesVerified: false,
        source: 'test',
        userSuppliedStatus: null,
      },
      raw: {},
      profileSha256: 'p',
      resumeStatus: 'extracted',
      resumeText: SECRET_RESUME,
      resumeSource: {
        kind: 'original_public_resume',
        sources: ['https://ada.test'],
        limitations: [],
        limitedSource: false,
        githubAccountKind: 'user',
      },
      prepared: JSON.parse(serializePreparedCandidate(prepared)),
      preparedSha256: 'x',
    });
  });

  it('lists and details subjects through public fields, without GitHub or Muse', async () => {
    const instance = await app();
    const list = await instance.inject({ method: 'GET', url: '/demo/candidates' });
    expect(DemoCandidateListSchema.parse(list.json()).some((c) => c.key === KEY)).toBe(true);
    const detail = await instance.inject({ method: 'GET', url: `/demo/candidates/${KEY}` });
    const body = DemoCandidateSchema.parse(detail.json());
    expect(body).toMatchObject({
      freshness: { state: 'not_started' },
      resume: { status: 'extracted' },
    });
    expect(body.repositories[0]).toMatchObject({ state: 'not_analyzed', commitSha: 'snap-one' });
    for (const text of [list.body, detail.body]) {
      for (const f of forbidden) expect(text).not.toContain(f);
    }
    expect(
      DemoJobListSchema.parse((await instance.inject({ method: 'GET', url: '/demo/jobs' })).json()),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ id: OUT, inScope: false })]));
    expect(
      (await instance.inject({ method: 'GET', url: '/demo/candidates/nobody' })).statusCode,
    ).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns schema-valid matches: out of scope, unavailable and scored', async () => {
    const instance = await app();
    const match = async (job: string) =>
      DemoMatchSchema.parse(
        (
          await instance.inject({ method: 'GET', url: `/demo/match?candidate=${KEY}&job=${job}` })
        ).json(),
      );
    expect(await match(OUT)).toMatchObject({
      availability: 'available',
      match: { status: 'unscored', reason: 'out_of_scope', subject: { key: KEY }, jobKey: OUT },
    });
    expect(await match(JOB)).toEqual({
      availability: 'unavailable',
      reason: 'candidate_not_current',
    });

    // A priority change before the job has a current analysis is refused.
    state.login = 'alice';
    state.operators = ['alice'];
    const early = await instance.inject({
      method: 'PUT',
      url: `/demo/jobs/${JOB}/priorities/unit-testing`,
      payload: { priority: 3 },
    });
    expect(early.statusCode).toBe(409);

    const options = {
      model: 'muse-spark-1.3' as const,
      budgetNamespace: `${RUN}:`,
      fetch: vi.fn(async () => reply(CANDIDATE_OUTPUT)) as unknown as typeof fetch,
    };
    await analyzeCandidate({ ...prepared, resume: { text: SECRET_RESUME } }, options);
    expect(await match(JOB)).toEqual({ availability: 'unavailable', reason: 'job_not_current' });
    await analyzeJob(
      {
        jobKey: JOB,
        employerId: EMPLOYER,
        title: 'Engineer',
        text: 'Write unit tests and design APIs',
        textSource: 'fixture_summary',
        dataUse: 'approved_public_demo',
      },
      { ...options, fetch: vi.fn(async () => reply(JOB_OUTPUT)) as unknown as typeof fetch },
    );
    const scored = await match(JOB);
    expect(scored).toMatchObject({
      availability: 'available',
      match: { status: 'scored', provisional: true, evidenceCoverage: (100 * 2) / 3 },
    });

    const detail = await instance.inject({ method: 'GET', url: `/demo/candidates/${KEY}` });
    expect(DemoCandidateSchema.parse(detail.json()).repositories[0]).toMatchObject({
      state: 'analyzed',
      skills: [{ skillId: 'unit-testing', levelScope: 'repository' }],
    });
    for (const f of forbidden) expect(detail.body).not.toContain(f);
  });

  it('recalculates the match after a priority change and reset, with no paid calls', async () => {
    state.login = 'alice';
    state.operators = ['alice'];
    const instance = await app();
    const calls = async () =>
      (
        await db
          .select({ n: sql<number>`count(*)::int` })
          .from(museCalls)
          .innerJoin(skillAssessments, eq(museCalls.assessmentId, skillAssessments.id))
          .where(like(skillAssessments.subjectKey, `${RUN}%`))
      )[0]!.n;
    const before = await calls();
    const compatibility = async () => {
      const m = DemoMatchSchema.parse(
        (
          await instance.inject({ method: 'GET', url: `/demo/match?candidate=${KEY}&job=${JOB}` })
        ).json(),
      );
      return m.availability === 'available' && m.match.status === 'scored'
        ? m.match.compatibility
        : null;
    };
    expect(await compatibility()).toBeCloseTo(100 / 3);

    const put = (skillId: string, priority: number | null) =>
      instance.inject({
        method: 'PUT',
        url: `/demo/jobs/${JOB}/priorities/${skillId}`,
        payload: { priority },
      });
    const changed = await put('api-design', 0);
    expect(changed.statusCode).toBe(200);
    expect(DemoJobSchema.parse(changed.json()).requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ skillId: 'api-design', priority: 0, prioritySource: 'override' }),
      ]),
    );
    expect(await compatibility()).toBe(50);
    expect((await put('ci-cd-pipelines', 1)).statusCode).toBe(422);
    const reset = DemoJobSchema.parse((await put('api-design', null)).json());
    expect(reset.requirements.find((r) => r.skillId === 'api-design')).toMatchObject({
      priority: 1,
      prioritySource: 'suggested',
    });
    expect(await compatibility()).toBeCloseTo(100 / 3);
    expect((await put('unit-testing', 1)).statusCode).toBe(200);
    expect(
      await db.select().from(jobPriorityOverrides).where(eq(jobPriorityOverrides.jobKey, JOB)),
    ).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await calls()).toBe(before);
  });
});
