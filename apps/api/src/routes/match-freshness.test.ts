import { randomUUID } from 'node:crypto';
import {
  DemoJobSchema,
  MatchDetailSchema,
  MatchListSchema,
  SKILL_CATALOGUE,
  type CandidateAssessment,
  type JobAssessment,
  type Score,
} from '@clearhire/shared';
import { eq, like, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Scores follow committed changes to saved markers and priorities on the next request, from both
// sides, and matching never calls Muse. Saved rows are written directly: nothing is graded here.
vi.mock('../env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../env.js')>();
  const overrides: Record<string, unknown> = { META_MODEL: 'muse-spark-1.3' };
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (t, p) => (p in overrides ? overrides[p as string] : t[p as keyof typeof t]),
    }),
  };
});

const { buildApp } = await import('../app.js');
const { db, databaseIsUp, pool } = await import('../db/client.js');
const { demoCandidates, demoEmployers, demoJobs, jobPriorityOverrides, repositorySelections, skillAssessments } =
  await import('../db/schema.js');
const { activeSelection, combinedKey, jobFingerprint } = await import('../lib/assessments.js');
const { VERIFIER_VERSION } = await import('../lib/assessment-verify.js');
const { jobInput } = await import('../lib/demo-results.js');
const { saveSelection } = await import('../lib/repository-selection.js');
const { fixtureRepoId } = await import('../lib/test-grading.js');

const MODEL = 'muse-spark-1.3' as const;
const CATALOGUE = { id: SKILL_CATALOGUE.id, version: SKILL_CATALOGUE.version };
const RUN = `test-${randomUUID()}`;
const EMPLOYER = `${RUN}-acme`;
const A = `${RUN}-a`;
const B = `${RUN}-b`;
const J1 = `${RUN}-j1`;
const J2 = `${RUN}-j2`;
const NEVER = `${RUN}-never`;
const FAILED = `${RUN}-failed`;
const OUT = `${RUN}-out`;
const up = await databaseIsUp();
const app = await buildApp();
app.log.level = 'silent';

const spyOnFetch = () => vi.spyOn(globalThis, 'fetch');
let fetchSpy: ReturnType<typeof spyOnFetch>;
beforeEach(() => {
  fetchSpy = spyOnFetch();
});
afterEach(() => {
  // Matching is pure: no request may leave the process (Muse is reached only through fetch).
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

afterAll(async () => {
  if (up) {
    await db.delete(skillAssessments).where(like(skillAssessments.subjectKey, `${RUN}%`));
    await db.delete(repositorySelections).where(like(repositorySelections.subjectKey, `${RUN}%`));
    await db.delete(jobPriorityOverrides).where(like(jobPriorityOverrides.jobKey, `${RUN}%`));
    await db.delete(demoJobs).where(like(demoJobs.id, `${RUN}%`));
    await db.delete(demoEmployers).where(like(demoEmployers.id, `${RUN}%`));
    await db.delete(demoCandidates).where(like(demoCandidates.key, `${RUN}%`));
  }
  await app.close();
  await pool.end();
});

// Strictly increasing run times, so the newest saved row is unambiguous.
let clock = Date.now();
const tick = () => new Date((clock += 1000));

type Skill = [string, 1 | 2 | 3];
type Req = [string, 1 | 2 | 3, number];

async function saveCandidate(key: string, skills: Skill[]) {
  const subject = { kind: 'demo' as const, key };
  const repoIds = (await activeSelection(subject)).map((s) => s.repoId);
  const result: CandidateAssessment = {
    kind: 'candidate',
    subject,
    model: MODEL,
    catalogue: CATALOGUE,
    status: 'complete',
    verification: 'location_verified_not_competency',
    coverage: {
      evidence: 'complete',
      unavailableRepos: [],
      omissions: [],
      duplicates: [],
      attributionGaps: [],
      limitations: [],
    },
    repositories: [],
    skills: skills.map(([skillId, level]) => ({
      skillId,
      level,
      confidence: 'high',
      rationale: '',
      supportingTags: [],
      evidence: [
        {
          ref: 'a1',
          repo: `octo/${key}`,
          commitSha: 'sha',
          path: 'src/a.ts',
          startLine: 1,
          endLine: 2,
          sha256: 'h',
          attribution: 'sole',
          contributions: [],
          alsoIn: [],
          note: null,
        },
      ],
      attributionLimitations: [],
    })),
    unsupportedSkills: [],
  };
  const at = tick();
  await db.insert(skillAssessments).values({
    kind: 'candidate',
    subjectKind: 'demo',
    subjectKey: key,
    cacheKey: combinedKey(subject, MODEL, repoIds),
    model: MODEL,
    catalogueVersion: CATALOGUE.version,
    status: 'complete',
    result,
    inputManifest: { repos: [], resumeSha256: null },
    verifierVersion: VERIFIER_VERSION,
    startedAt: at,
    completedAt: at,
  });
}

async function saveJob(id: string, requirements: Req[]) {
  const [row] = await db.select().from(demoJobs).where(eq(demoJobs.id, id));
  const result: JobAssessment = {
    kind: 'job',
    jobKey: id,
    employerId: EMPLOYER,
    title: row!.title,
    model: MODEL,
    catalogue: CATALOGUE,
    textSource: row!.textSource,
    inScope: true,
    outOfScopeReason: null,
    requirements: requirements.map(([skillId, requiredLevel, suggestedPriority]) => ({
      skillId,
      requiredLevel,
      suggestedPriority,
      refs: [{ ref: 'j1', text: row!.text }],
      referenceStatus: 'verified',
      invalidRefs: [],
    })),
    eligibilityConstraints: [],
    supportingTags: [],
  };
  const at = tick();
  await db.insert(skillAssessments).values({
    kind: 'job',
    subjectKind: 'demo',
    subjectKey: id,
    cacheKey: jobFingerprint(jobInput(row!), { model: MODEL }).cacheKey,
    model: MODEL,
    catalogueVersion: CATALOGUE.version,
    status: 'complete',
    result,
    verifierVersion: VERIFIER_VERSION,
    startedAt: at,
    completedAt: at,
  });
}

async function as(kind: 'candidate' | 'employer', key: string) {
  const res = await app.inject({ method: 'POST', url: '/demo/identity', payload: { kind, key } });
  expect(res.statusCode).toBe(200);
  return { ch_demo: res.cookies.find((c) => c.name === 'ch_demo')!.value };
}

type Cookies = Awaited<ReturnType<typeof as>>;
/** This run's scores as `candidate/job` → compatibility (null when unscored). */
async function scores(cookies: Cookies) {
  const res = await app.inject({ method: 'GET', url: '/demo/matches', cookies });
  expect(res.statusCode).toBe(200);
  return new Map(
    MatchListSchema.parse(res.json())
      .filter((m) => m.job.id.startsWith(RUN) && m.candidate.key.startsWith(RUN))
      .map((m): [string, Score] => [`${m.candidate.key}/${m.job.id}`, m.score]),
  );
}
const compat = async (cookies: Cookies) =>
  new Map([...(await scores(cookies))].map(([k, s]) => [k, s.compatibility]));
const savedRows = async () =>
  (
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(skillAssessments)
      .where(like(skillAssessments.subjectKey, `${RUN}%`))
  )[0]!.n;

describe.runIf(up)('match freshness (Postgres)', () => {
  let seeker: Cookies;
  let employer: Cookies;

  it('seeds two seekers and five postings', async () => {
    await db.insert(demoEmployers).values({
      id: EMPLOYER,
      name: 'Acme',
      description: 'Tools',
      url: 'https://acme.test',
      raw: {},
      recordSha256: 'e',
    });
    const job = (id: string, inScope = true) => ({
      id,
      employerId: EMPLOYER,
      title: 'Engineer',
      sourceUrl: 'https://acme.test/1',
      scenario: 'possible_skill_overlap',
      inScope,
      text: `Write unit tests and design APIs for ${id}`,
      textSource: 'fixture_summary' as const,
      raw: {},
      recordSha256: 'r',
      inputSha256: 'i',
    });
    await db.insert(demoJobs).values([job(J1), job(J2), job(NEVER), job(FAILED), job(OUT, false)]);
    for (const key of [A, B]) {
      await db.insert(demoCandidates).values({
        key,
        name: key,
        githubUrl: 'https://github.com/x',
        githubLogin: 'x',
        repositories: [],
        verification: {},
        raw: {},
        profileSha256: 'p',
      });
      const repo = `octo/${key}`;
      await saveSelection(
        { kind: 'demo', key },
        [{ id: fixtureRepoId(repo), fullName: repo, pushedAt: null }],
        'demo_default',
      );
    }
    await saveCandidate(A, [['unit-testing', 1]]);
    await saveCandidate(B, [
      ['unit-testing', 1],
      ['api-design', 1],
    ]);
    await saveJob(J1, [
      ['unit-testing', 2, 2],
      ['api-design', 1, 1],
    ]);
    await saveJob(J2, [
      ['unit-testing', 3, 1],
      ['debugging', 1, 1],
    ]);
    // An attempt for older inputs that failed before anything was saved.
    await db.insert(skillAssessments).values({
      kind: 'job',
      subjectKind: 'demo',
      subjectKey: FAILED,
      cacheKey: 'an-older-input-key',
      model: MODEL,
      catalogueVersion: CATALOGUE.version,
      status: 'failed',
      errorCode: 'interrupted',
      completedAt: tick(),
    });
    seeker = await as('candidate', A);
    employer = await as('employer', EMPLOYER);
  });

  it("a seeker-marker change updates that seeker's matches on every posting, from both sides", async () => {
    const before = { seeker: await compat(seeker), employer: await compat(employer) };
    expect(before.seeker.get(`${A}/${J1}`)).toBeCloseTo(100 / 3);
    expect(before.seeker.get(`${A}/${J2}`)).toBe(0);

    await saveCandidate(A, [['unit-testing', 2]]);
    const after = { seeker: await compat(seeker), employer: await compat(employer) };
    for (const view of [after.seeker, after.employer]) {
      expect(view.get(`${A}/${J1}`)).toBeCloseTo(200 / 3);
      expect(view.get(`${A}/${J2}`)).toBe(25);
    }
    // The other seeker is untouched.
    for (const job of [J1, J2]) {
      expect(after.employer.get(`${B}/${job}`)).toBe(before.employer.get(`${B}/${job}`));
    }
  });

  it("a posting-marker change updates that posting's matches for every seeker", async () => {
    const before = await compat(employer);
    await saveJob(J1, [
      ['unit-testing', 3, 2],
      ['api-design', 2, 1],
    ]);
    const after = await compat(employer);
    expect(after.get(`${A}/${J1}`)).toBeCloseTo(100 / 3);
    expect(after.get(`${B}/${J1}`)).toBeCloseTo(50 / 3);
    for (const key of [A, B]) expect(after.get(`${key}/${J2}`)).toBe(before.get(`${key}/${J2}`));
    expect((await compat(seeker)).get(`${A}/${J1}`)).toBeCloseTo(100 / 3);
  });

  it('a priority change updates the score without regrading either side', async () => {
    const rows = await savedRows();
    const res = await app.inject({
      method: 'PUT',
      url: `/demo/jobs/${J1}/priorities/api-design`,
      payload: { priority: 3 },
      cookies: employer,
    });
    expect(res.statusCode).toBe(200);
    // A: unit-testing partly met (1 of 2), api-design not shown (0 of 3).
    expect((await compat(employer)).get(`${A}/${J1}`)).toBe(20);
    expect((await compat(seeker)).get(`${A}/${J1}`)).toBe(20);
    const detail = MatchDetailSchema.parse(
      (await app.inject({ method: 'GET', url: `/demo/matches/${A}/${J1}`, cookies: seeker })).json(),
    );
    expect(detail.score.compatibility).toBe(20);
    expect(await savedRows()).toBe(rows);
  });

  it('keeps the last saved score visible while updating or after an update fails', async () => {
    const pair = `${A}/${J2}`;
    const setRun = (runStatus: 'idle' | 'queued' | 'pending' | 'failed') =>
      db.update(demoJobs).set({ runStatus }).where(eq(demoJobs.id, J2));

    await setRun('pending');
    expect((await scores(seeker)).get(pair)).toMatchObject({
      state: 'scored',
      compatibility: 25,
      pending: true,
      updateFailed: false,
    });
    await setRun('failed');
    expect((await scores(seeker)).get(pair)).toMatchObject({
      state: 'scored',
      compatibility: 25,
      pending: false,
      updateFailed: true,
    });

    // New posting text: score from the last saved requirements until their replacement is ready.
    await db.update(demoJobs).set({ text: 'Different text', runStatus: 'idle' }).where(eq(demoJobs.id, J2));
    expect((await scores(seeker)).get(pair)).toMatchObject({ state: 'scored', compatibility: 25, usingLastSaved: true });
    await setRun('queued');
    expect((await scores(seeker)).get(pair)).toMatchObject({
      state: 'scored',
      compatibility: 25,
      usingLastSaved: true,
      pending: true,
    });
    await setRun('failed');
    expect((await scores(seeker)).get(pair)).toMatchObject({
      state: 'scored', compatibility: 25, usingLastSaved: true, updateFailed: true,
    });
  });

  it('tells never analyzed, failed with nothing saved, and out of scope apart', async () => {
    const list = await scores(employer);
    expect(list.get(`${A}/${NEVER}`)).toMatchObject({ state: 'not_analyzed', compatibility: null });
    // Only a failed attempt for older inputs exists: that is a failure, not an outdated result.
    expect(list.get(`${A}/${FAILED}`)).toMatchObject({ state: 'failed', compatibility: null });
    expect([...list.keys()].some((k) => k.endsWith(`/${OUT}`))).toBe(false);
    const detail = async (id: string) =>
      DemoJobSchema.parse((await app.inject({ method: 'GET', url: `/demo/jobs/${id}` })).json())
        .freshness;
    expect(await detail(FAILED)).toMatchObject({ state: 'failed', errorCode: 'interrupted' });
    expect(await detail(NEVER)).toMatchObject({ state: 'not_started' });
    expect(await detail(OUT)).toMatchObject({ state: 'not_applicable' });
  });
});
