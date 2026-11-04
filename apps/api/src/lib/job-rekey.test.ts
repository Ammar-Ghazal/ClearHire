import { randomUUID } from 'node:crypto';
import { SKILL_CATALOGUE, type JobAssessment } from '@clearhire/shared';
import { eq, like } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { databaseIsUp, db, pool } from '../db/client.js';
import { demoEmployers, demoJobs, skillAssessments } from '../db/schema.js';
import { VERIFIER_VERSION } from './assessment-verify.js';
import { cacheKeyOf, candidateVersions, jobFingerprint } from './assessments.js';
import { jobInput, jobState } from './demo-results.js';
import { rekeyJobs } from './job-rekey.js';

// Real Postgres; every row is scoped to this run.
const RUN = `test-${randomUUID()}`;
const EMPLOYER = `${RUN}-acme`;
const MODEL = 'muse-spark-1.3' as const;
const up = await databaseIsUp();

afterAll(async () => {
  if (up) {
    await db.delete(skillAssessments).where(like(skillAssessments.subjectKey, `${RUN}%`));
    await db.delete(demoJobs).where(like(demoJobs.id, `${RUN}%`));
    await db.delete(demoEmployers).where(like(demoEmployers.id, `${RUN}%`));
  }
  await pool.end();
});

/** A job and a saved result under the pre-split key (attribution version 1). */
async function seed(suffix: string, row: Partial<typeof skillAssessments.$inferInsert> = {}) {
  const id = `${RUN}-${suffix}`;
  const [job] = await db
    .insert(demoJobs)
    .values({
      id,
      employerId: EMPLOYER,
      title: 'Engineer',
      sourceUrl: 'https://acme.test/1',
      scenario: 'possible_skill_overlap',
      inScope: true,
      text: `Write unit tests (${suffix})`,
      textSource: 'full_description',
      raw: {},
      recordSha256: 'r',
      inputSha256: 'i',
    })
    .returning();
  const { body, input } = jobFingerprint(jobInput(job!), { model: MODEL });
  const result: JobAssessment = {
    kind: 'job',
    jobKey: id,
    employerId: EMPLOYER,
    title: 'Engineer',
    model: MODEL,
    catalogue: { id: SKILL_CATALOGUE.id, version: SKILL_CATALOGUE.version },
    textSource: 'full_description',
    inScope: true,
    outOfScopeReason: null,
    requirements: [],
    eligibilityConstraints: [],
    supportingTags: [],
  };
  await db.insert(skillAssessments).values({
    kind: 'job',
    subjectKind: 'demo',
    subjectKey: id,
    cacheKey: cacheKeyOf({ kind: 'job', body, job: input }, { ...candidateVersions(), cleaner: 1, attribution: 1 }),
    model: MODEL,
    catalogueVersion: SKILL_CATALOGUE.version,
    status: 'complete',
    result,
    verifierVersion: VERIFIER_VERSION,
    completedAt: new Date(),
    ...row,
  });
  return job!;
}

describe.runIf(up)('job rekey (Postgres)', () => {
  it('reuses only results proven to come from the same inputs and rules', async () => {
    await db.insert(demoEmployers).values({
      id: EMPLOYER,
      name: 'Acme',
      description: 'Tools',
      url: 'https://acme.test',
      raw: {},
      recordSha256: 'e',
    });
    const same = await seed('same');
    const edited = await seed('edited');
    await db.update(demoJobs).set({ text: 'Edited posting' }).where(eq(demoJobs.id, edited.id));
    await seed('verifier', { verifierVersion: VERIFIER_VERSION + 1 });
    await seed('model', { model: 'muse-spark-1.3-contributor' });
    await seed('payload', { result: { kind: 'job' } });

    const reasons = async (apply: boolean) =>
      Object.fromEntries(
        (await rekeyJobs({ model: MODEL, apply, prefix: RUN })).map((o) => [
          o.jobKey.slice(RUN.length + 1),
          o.skipped,
        ]),
      );
    const expected = {
      same: null,
      edited: 'inputs_or_rules_changed',
      verifier: 'verifier_changed',
      model: 'model_changed',
      payload: 'invalid_payload',
    };
    const current = async (job: typeof same) =>
      (await jobState((await db.select().from(demoJobs).where(eq(demoJobs.id, job.id)))[0]!, {
        model: MODEL,
      })).freshness.state;

    // A dry run changes nothing.
    expect(await reasons(false)).toEqual(expected);
    expect(await current(same)).toBe('outdated');

    expect(await reasons(true)).toEqual(expected);
    expect(await current(same)).toBe('current');
    expect(await current(edited)).toBe('outdated');
    // Running again is a no-op.
    expect((await reasons(true)).same).toBe('already_current');
  });
});
