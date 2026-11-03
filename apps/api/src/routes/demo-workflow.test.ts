import { randomUUID } from 'node:crypto';
import {
  DemoIdentitySchema,
  InterviewListSchema,
  MatchDetailSchema,
  MatchListSchema,
  MessageListSchema,
  OfferListSchema,
  OfferSchema,
  PreferencesSchema,
} from '@clearhire/shared';
import { like } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { databaseIsUp, db, pool } from '../db/client.js';
import { demoCandidates, demoEmployers, demoJobs } from '../db/schema.js';

// Real Postgres; every row is scoped to this run and removed afterwards (relationships cascade).
const RUN = `test-${randomUUID()}`;
const EMPLOYER = `${RUN}-acme`;
const OTHER_EMPLOYER = `${RUN}-other`;
const JOB = `${RUN}-job`;
const SECOND_JOB = `${RUN}-job-2`;
const CAND = `${RUN}-cand`;
const ORG = `${RUN}-org`;
const up = await databaseIsUp();
const app = await buildApp();
app.log.level = 'silent';

afterAll(async () => {
  if (up) {
    await db.delete(demoJobs).where(like(demoJobs.id, `${RUN}%`));
    await db.delete(demoEmployers).where(like(demoEmployers.id, `${RUN}%`));
    await db.delete(demoCandidates).where(like(demoCandidates.key, `${RUN}%`));
  }
  await app.close();
  await pool.end();
});

type Cookies = Record<string, string>;

async function as(kind: 'candidate' | 'employer', key: string): Promise<Cookies> {
  const res = await app.inject({ method: 'POST', url: '/demo/identity', payload: { kind, key } });
  expect(res.statusCode).toBe(200);
  return { ch_demo: res.cookies.find((c) => c.name === 'ch_demo')!.value };
}

const call = (cookies: Cookies, method: 'GET' | 'PUT' | 'POST', url: string, payload?: object) =>
  app.inject(payload === undefined ? { method, url, cookies } : { method, url, cookies, payload });

const match = (pair = `${CAND}/${JOB}`) => `/demo/matches/${pair}`;

describe.runIf(up)('demo workflow (Postgres)', () => {
  let employer: Cookies;
  let candidate: Cookies;
  let other: Cookies;

  it('seeds rows and chooses identities, refusing organizations and unknown keys', async () => {
    await db.insert(demoEmployers).values(
      [EMPLOYER, OTHER_EMPLOYER].map((id) => ({
        id,
        name: id,
        description: 'Tools',
        url: 'https://acme.test',
        location: 'Toronto, ON',
        raw: {},
        recordSha256: 'e',
      })),
    );
    const job = {
      employerId: EMPLOYER,
      title: 'Engineer',
      sourceUrl: 'https://acme.test/1',
      scenario: 'possible_skill_overlap',
      inScope: true,
      text: 'Write tests',
      textSource: 'fixture_summary' as const,
      raw: {},
      recordSha256: 'r',
      inputSha256: 'i',
    };
    await db.insert(demoJobs).values([
      { ...job, id: JOB },
      { ...job, id: SECOND_JOB },
    ]);
    const candidateRow = {
      githubUrl: 'https://github.com/x',
      githubLogin: 'x',
      repositories: [],
      verification: {},
      raw: {},
      profileSha256: 'p',
    };
    await db.insert(demoCandidates).values([
      { ...candidateRow, key: CAND, name: 'Ada' },
      { ...candidateRow, key: ORG, name: 'Lab', organization: true },
    ]);

    expect((await app.inject({ method: 'GET', url: '/demo/identity' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/demo/matches' })).statusCode).toBe(401);
    for (const payload of [
      { kind: 'candidate', key: ORG },
      { kind: 'employer', key: 'nobody' },
    ]) {
      expect(
        (await app.inject({ method: 'POST', url: '/demo/identity', payload })).statusCode,
      ).toBe(404);
    }
    employer = await as('employer', EMPLOYER);
    candidate = await as('candidate', CAND);
    other = await as('employer', OTHER_EMPLOYER);
    const me = DemoIdentitySchema.parse((await call(employer, 'GET', '/demo/identity')).json());
    const list = MatchListSchema.parse((await call(employer, 'GET', '/demo/matches')).json());
    expect(list.every((m) => m.relationship.stage === 'needs_response')).toBe(true);
    expect(list.some((m) => m.candidate.key === ORG)).toBe(false);
    expect(me).toMatchObject({
      identity: { kind: 'employer', location: 'Toronto, ON' },
      badges: { matches: list.length },
    });
  });

  it('opens nothing until both answer, then Maybe leads to Discussion', async () => {
    const answer = (c: Cookies, value: string) =>
      call(c, 'PUT', `${match()}/answer`, { answer: value });
    expect((await answer(other, 'yes')).statusCode).toBe(404);
    const waiting = MatchDetailSchema.parse((await answer(candidate, 'maybe')).json());
    expect(waiting.relationship).toMatchObject({ stage: 'waiting', candidateAnswer: 'maybe' });
    // Messages are refused until Discussion opens.
    expect((await call(candidate, 'POST', `${match()}/messages`, { body: 'Hi' })).statusCode).toBe(
      409,
    );
    expect((await answer(candidate, 'yes')).statusCode).toBe(409);
    const discussion = MatchDetailSchema.parse((await answer(employer, 'yes')).json());
    expect(discussion.relationship.stage).toBe('discussion');
  });

  it('keeps a Discussion and moves to Interview when both confirm', async () => {
    const posted = await call(candidate, 'POST', `${match()}/messages`, { body: 'Hello there' });
    expect(MessageListSchema.parse(posted.json())).toMatchObject([
      { authorSide: 'candidate', body: 'Hello there' },
    ]);
    const confirm = (c: Cookies) => call(c, 'POST', `${match()}/confirm-interview`);
    expect(MatchDetailSchema.parse((await confirm(candidate)).json()).relationship).toMatchObject({
      stage: 'discussion',
      candidateConfirmed: true,
    });
    expect(MatchDetailSchema.parse((await confirm(employer)).json()).relationship.stage).toBe(
      'interview',
    );
    expect((await confirm(employer)).statusCode).toBe(409);
  });

  it('lets the employer propose and replace slots until the candidate confirms one', async () => {
    const details = (slots: string[]) => ({
      format: 'video',
      lengthMinutes: 45,
      location: 'https://meet.test/abc',
      slots,
    });
    const put = (c: Cookies, slots: string[]) =>
      call(c, 'PUT', `${match()}/interview`, details(slots));
    expect((await put(candidate, ['2026-12-01T15:00:00Z'])).statusCode).toBe(403);
    expect(
      DemoIdentitySchema.parse((await call(employer, 'GET', '/demo/identity')).json()).badges
        .interviews,
    ).toBe(1);
    await put(employer, ['2026-12-01T15:00:00Z']);
    const replaced = MatchDetailSchema.parse(
      (await put(employer, ['2026-12-02T15:00:00Z', '2026-12-03T15:00:00Z'])).json(),
    );
    expect(replaced.interview?.slots).toHaveLength(2);

    const listed = InterviewListSchema.parse((await call(candidate, 'GET', '/demo/interviews')).json());
    expect(listed).toHaveLength(1);
    const slotId = listed[0]!.interview!.slots[1]!.id;
    expect((await call(employer, 'POST', `${match()}/interview/confirm`, { slotId })).statusCode).toBe(
      403,
    );
    const confirmed = MatchDetailSchema.parse(
      (await call(candidate, 'POST', `${match()}/interview/confirm`, { slotId })).json(),
    );
    expect(confirmed.interview?.confirmedSlotId).toBe(slotId);
    expect((await put(employer, ['2026-12-04T15:00:00Z'])).statusCode).toBe(409);
  });

  it('keeps drafts private, freezes shared terms and completes on acceptance', async () => {
    const terms = {
      role: 'Engineer',
      baseSalaryCad: 120000,
      startDate: '2027-01-11',
      arrangement: 'hybrid',
      note: 'Welcome',
    };
    expect((await call(candidate, 'PUT', `${match()}/offer`, terms)).statusCode).toBe(403);
    const drafted = MatchDetailSchema.parse((await call(employer, 'PUT', `${match()}/offer`, terms)).json());
    const id = drafted.offer!.id;
    expect(drafted.offer?.status).toBe('draft');
    expect(OfferListSchema.parse((await call(candidate, 'GET', '/demo/offers')).json())).toEqual([]);
    expect((await call(candidate, 'GET', `/demo/offers/${id}`)).statusCode).toBe(404);

    const shared = OfferSchema.parse((await call(employer, 'POST', `/demo/offers/${id}/share`)).json());
    expect(shared).toMatchObject({ status: 'shared', stage: 'offer_shared' });
    expect((await call(employer, 'PUT', `${match()}/offer`, terms)).statusCode).toBe(409);
    expect(
      DemoIdentitySchema.parse((await call(candidate, 'GET', '/demo/identity')).json()).badges.offers,
    ).toBe(1);

    const accepted = OfferSchema.parse((await call(candidate, 'POST', `/demo/offers/${id}/accept`)).json());
    expect(accepted).toMatchObject({ status: 'accepted', stage: 'offer_accepted' });
    // Completed: read-only for answers and Discussion, still readable.
    expect((await call(employer, 'PUT', `${match()}/answer`, { answer: 'no' })).statusCode).toBe(409);
    expect((await call(employer, 'POST', `${match()}/messages`, { body: 'Hi' })).statusCode).toBe(409);
    expect(MessageListSchema.parse((await call(employer, 'GET', `${match()}/messages`)).json())).toHaveLength(1);
  });

  it('withdraws a shared offer when the employer changes to No', async () => {
    const pair = `${CAND}/${SECOND_JOB}`;
    await call(candidate, 'PUT', `${match(pair)}/answer`, { answer: 'yes' });
    await call(employer, 'PUT', `${match(pair)}/answer`, { answer: 'yes' });
    const drafted = MatchDetailSchema.parse(
      (
        await call(employer, 'PUT', `${match(pair)}/offer`, {
          role: 'Engineer',
          baseSalaryCad: 100000,
          startDate: '2027-02-01',
          arrangement: 'remote',
          note: '',
        })
      ).json(),
    );
    await call(employer, 'POST', `/demo/offers/${drafted.offer!.id}/share`);
    const closed = MatchDetailSchema.parse(
      (await call(employer, 'PUT', `${match(pair)}/answer`, { answer: 'no' })).json(),
    );
    expect(closed.relationship.stage).toBe('you_declined');
    expect(closed.offer?.status).toBe('withdrawn');
    const seen = MatchDetailSchema.parse((await call(candidate, 'GET', match(pair))).json());
    expect(seen.relationship.stage).toBe('they_declined');
    expect((await call(candidate, 'POST', `/demo/offers/${drafted.offer!.id}/accept`)).statusCode).toBe(
      409,
    );
  });

  it('stores seeker preferences for candidates only', async () => {
    const prefs = { titles: ['Engineer'], locations: ['Toronto'], arrangements: ['remote'] };
    expect(PreferencesSchema.parse((await call(candidate, 'PUT', '/demo/profile/preferences', prefs)).json())).toEqual(prefs);
    expect(PreferencesSchema.parse((await call(candidate, 'GET', '/demo/profile/preferences')).json())).toEqual(prefs);
    expect((await call(employer, 'GET', '/demo/profile/preferences')).statusCode).toBe(403);
  });
});
