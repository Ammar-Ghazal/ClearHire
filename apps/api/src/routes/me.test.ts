import {
  PublicRepositoriesSchema,
  RepositorySelectionSavedSchema,
} from '@clearhire/shared';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Real Postgres; the session and GitHub are mocked. Listing returns metadata only.
const state = vi.hoisted(() => ({ userId: null as string | null, githubUserId: 0 }));
vi.mock('../lib/sessions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/sessions.js')>()),
  currentUserId: vi.fn(async () => state.userId),
}));
const listed = vi.hoisted(() =>
  [1, 2, 3, 4].map((n) => ({
    id: 9_000 + n,
    full_name: `me/r${n}`,
    private: false,
    description: null,
    stargazers_count: n,
    pushed_at: `2026-01-0${n}T00:00:00Z`,
    fork: n === 4,
    archived: false,
    size: 1,
  })),
);
vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(() => ({
    hook: { before: vi.fn() },
    rest: {
      repos: { listForUser: {} },
      users: { getAuthenticated: async () => ({ data: { id: state.githubUserId } }) },
    },
    paginate: vi.fn(async () => listed),
  })),
}));
vi.mock('./auth.js', () => ({ authRoutes: async () => {} }));
vi.mock('./health.js', () => ({ healthRoutes: async () => {} }));
vi.mock('./demo.js', () => ({ demoRoutes: async () => {} }));
vi.mock('./demo-workflow.js', () => ({ demoWorkflowRoutes: async () => {} }));

const { db, databaseIsUp, pool } = await import('../db/client.js');
const { githubConnections, museCalls, repositorySelections, skillAssessments, users } = await import(
  '../db/schema.js'
);
const { env } = await import('../env.js');
const { encrypt } = await import('../lib/crypto.js');
const { buildApp } = await import('../app.js');
const { judgeModelCalls, liveJudgeAssessment } = await import('../lib/judge-profile.js');

const up = await databaseIsUp();
const LOGIN = `test-${randomUUID().slice(0, 8)}`;

afterAll(async () => {
  if (up && state.userId) {
    await db.delete(repositorySelections).where(eq(repositorySelections.subjectKey, state.userId));
  }
  if (up) await db.delete(users).where(eq(users.login, LOGIN));
  await pool.end();
});

describe.runIf(up)('live repository selection (Postgres)', () => {
  it('lists public repositories and saves exactly the chosen ones, starting no grading', async () => {
    const [user] = await db
      .insert(users)
      .values({ githubUserId: Math.floor(Math.random() * 1e9), login: LOGIN })
      .returning();
    state.userId = user!.id;
    state.githubUserId = user!.githubUserId;
    await db.insert(githubConnections).values({
      userId: user!.id,
      accessTokenEnc: encrypt('ghu_test', env.TOKEN_ENCRYPTION_KEY),
    });
    const app = await buildApp();

    const list = await app.inject({ method: 'GET', url: '/me/repositories' });
    expect(list.statusCode).toBe(200);
    const repos = PublicRepositoriesSchema.parse(list.json());
    expect(repos.map((r) => [r.fullName, r.selected])).toEqual([
      ['me/r1', false],
      ['me/r2', false],
      ['me/r3', false],
      ['me/r4', false],
    ]);

    const put = (repoIds: unknown) =>
      app.inject({ method: 'PUT', url: '/me/repositories/selection', payload: { repoIds } });
    // Chosen order is kept; rankings never add anything, forks may be chosen.
    const saved = await put([9_004, 9_001]);
    expect(saved.statusCode).toBe(200);
    expect(RepositorySelectionSavedSchema.parse(saved.json())).toMatchObject({
      saved: true,
      grading: 'not_started',
    });
    const rows = await db
      .select()
      .from(repositorySelections)
      .where(eq(repositorySelections.subjectKey, user!.id));
    const active = rows.filter((r) => r.active).sort((a, b) => a.position - b.position);
    expect(active.map((r) => r.repoId)).toEqual([9_004, 9_001]);
    expect(rows.every((r) => r.subjectKind === 'user' && r.source === 'user')).toBe(true);
    const relisted = PublicRepositoriesSchema.parse(
      (await app.inject({ method: 'GET', url: '/me/repositories' })).json(),
    );
    expect(relisted.filter((r) => r.selected).map((r) => r.id).sort()).toEqual([9_001, 9_004]);

    // Only the user's own public repositories, at most 10, each once.
    expect((await put([12_345])).statusCode).toBe(400);
    expect((await put(Array.from({ length: 11 }, (_, i) => 9_001 + i))).statusCode).toBe(400);
    expect((await put([9_001, 9_001])).statusCode).toBe(400);
    // Deselecting keeps the row (and any saved results) for reuse, inactive.
    expect((await put([9_001])).statusCode).toBe(200);
    const after = await db
      .select()
      .from(repositorySelections)
      .where(eq(repositorySelections.subjectKey, user!.id));
    expect(after.find((r) => r.repoId === 9_004)).toMatchObject({ active: false });
    // Nothing was graded or queued.
    expect(
      await db.select().from(skillAssessments).where(eq(skillAssessments.subjectKey, user!.id)),
    ).toEqual([]);

    const withoutConsent = await app.inject({ method: 'POST', url: '/me/profile/analysis' });
    expect(withoutConsent.statusCode).toBe(400);
    expect(withoutConsent.json().error.code).toBe('contributor_consent_required');

    await db.update(githubConnections).set({ accessTokenExpiresAt: new Date(0) })
      .where(eq(githubConnections.userId, user!.id));
    const expired = await app.inject({ method: 'POST', url: '/me/profile/analysis' });
    expect(expired.statusCode).toBe(409);
    expect(expired.json().error.code).toBe('github_reconnect');

    const model = 'muse-spark-1.3-contributor';
    const assessments = await db.insert(skillAssessments).values([
      { kind: 'repository', subjectKind: 'user', subjectKey: user!.id, cacheKey: LOGIN,
        repoId: 9_001, part: 'test', model, catalogueVersion: 3, status: 'failed' },
      { kind: 'job', subjectKind: 'demo', subjectKey: LOGIN, cacheKey: LOGIN,
        model, catalogueVersion: 3, status: 'failed' },
    ]).returning();
    try {
      const calls = await db.insert(museCalls).values(assessments.map(({ id }) => ({
        assessmentId: id, model, attempt: 1, scopes: ['internal-budget'],
        settlement: 'settled' as const, reservedMicroUsd: 100, costMicroUsd: 50,
        promptTokens: 10, latencyMs: 200,
      }))).returning();
      expect(await judgeModelCalls(user!.id, [], [])).toEqual([]);
      expect(await judgeModelCalls(user!.id, [], [calls[1]!.id])).toEqual([]);
      expect(await judgeModelCalls(user!.id, [], [calls[0]!.id])).toHaveLength(1);
      const withCalls = await app.inject('/me/profile?modelCalls=true');
      expect(withCalls.statusCode).toBe(200);
      expect(withCalls.json().modelCalls).toHaveLength(1);
      expect(withCalls.json().modelCalls[0]).toMatchObject({
        repository: 'me/r1', model, promptTokens: 10, latencyMs: 200, costMicroUsd: 50,
      });
      expect(withCalls.body).not.toContain('internal-budget');
      expect((await app.inject('/me/profile')).json()).not.toHaveProperty('modelCalls');

      // A live preview starts empty (earlier results are not shown) and saves no combined row.
      const live = await liveJudgeAssessment(user!.id, new Date());
      expect(live).toMatchObject({
        skills: [], coverage: { unavailableRepos: [{ repo: 'me/r1', reason: 'not_processed' }] },
      });
      const combinedRows = await db.select().from(skillAssessments)
        .where(eq(skillAssessments.subjectKey, user!.id));
      expect(combinedRows.some((r) => r.kind === 'candidate')).toBe(false);
    } finally {
      for (const { id } of assessments) await db.delete(skillAssessments).where(eq(skillAssessments.id, id));
    }

    state.userId = null;
    expect((await app.inject({ method: 'GET', url: '/me/profile?modelCalls=true' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/me/repositories' })).statusCode).toBe(401);
    state.userId = user!.id;
    await app.close();
  });
});
