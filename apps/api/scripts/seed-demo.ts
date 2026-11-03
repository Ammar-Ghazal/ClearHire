// Exports or loads the demo seed: imported fixtures, their saved analyses and each seeker's recorded
// analysis spend, so the demo runs on a fresh database without GitHub, Muse or the résumé PDFs.
//   pnpm --filter @clearhire/api demo:seed export   write data/demo/seed/demo-seed.json from this database
//   pnpm --filter @clearhire/api demo:seed load     upsert the fixtures and add the saved analyses
// Every record passes an explicit field allowlist: export drops anything else, and load rejects a
// seed with any other field, so repository code or raw model output can never be restored.
// Loading never calls GitHub or Muse, never lowers recorded spend and never touches relationships,
// offers or other workflow rows.
import { CandidateAssessmentSchema, JobAssessmentSchema } from '@clearhire/shared';
import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, pool } from '../src/db/client.js';
import {
  demoCandidates,
  demoEmployers,
  demoJobs,
  museSpendBudgets,
  skillAssessments,
} from '../src/db/schema.js';
import { CANDIDATE_SPEND_CAP_USD } from '../src/lib/assessments.js';
import { SeedSchema } from '../src/lib/demo-seed.js';

const FILE = fileURLToPath(new URL('../../../data/demo/seed/demo-seed.json', import.meta.url));
const SAVED = ['complete', 'partial', 'no_attributed_evidence'] as const;
const SEEKER_SCOPE = 'subject:candidate:demo:';

async function exportSeed() {
  const employers = await db.select().from(demoEmployers).orderBy(demoEmployers.id);
  const jobs = await db.select().from(demoJobs).orderBy(demoJobs.id);
  const candidates = await db.select().from(demoCandidates).orderBy(demoCandidates.key);
  const assessments = await db
    .select()
    .from(skillAssessments)
    .where(
      and(
        eq(skillAssessments.subjectKind, 'demo'),
        inArray(skillAssessments.status, [...SAVED]),
        or(
          and(
            eq(skillAssessments.kind, 'candidate'),
            inArray(skillAssessments.subjectKey, candidates.map((c) => c.key)),
          ),
          and(
            eq(skillAssessments.kind, 'job'),
            inArray(skillAssessments.subjectKey, jobs.map((j) => j.id)),
          ),
        ),
      ),
    )
    .orderBy(skillAssessments.kind, skillAssessments.subjectKey, skillAssessments.completedAt);
  const spend = await db
    .select({ scope: museSpendBudgets.scope, spentMicroUsd: museSpendBudgets.spentMicroUsd })
    .from(museSpendBudgets)
    .where(like(museSpendBudgets.scope, `${SEEKER_SCOPE}%`))
    .orderBy(museSpendBudgets.scope);
  // Non-strict parsing keeps only allowlisted fields: run state, ids and timestamps are local.
  const seed = SeedSchema.strip().parse({
    employers: employers.map((e) => SeedSchema.shape.employers.element.strip().parse(e)),
    jobs: jobs.map((j) => SeedSchema.shape.jobs.element.strip().parse(j)),
    candidates: candidates.map((c) => SeedSchema.shape.candidates.element.strip().parse(c)),
    assessments: assessments.map((a) => SeedSchema.shape.assessments.element.strip().parse(a)),
    spend,
  });
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, `${JSON.stringify(seed, null, 1)}\n`);
  const count = (kind: string) => assessments.filter((a) => a.kind === kind).length;
  console.log(
    `Wrote ${FILE}: ${employers.length} employers, ${jobs.length} jobs, ` +
      `${candidates.length} candidates, ${count('candidate')} candidate and ${count('job')} job ` +
      `analyses, ${spend.length} seeker spend record(s).`,
  );
}

async function loadSeed() {
  const parsed = SeedSchema.safeParse(JSON.parse(readFileSync(FILE, 'utf8')));
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.') || '(root)');
    throw new Error(`Seed rejected (unexpected or invalid fields): ${fields.slice(0, 5).join(', ')}`);
  }
  const seed = parsed.data;
  const added = await db.transaction(async (tx) => {
    const now = new Date();
    const idle = { runStatus: 'idle' as const, runId: null, runError: null, queuedAt: null };
    for (const e of seed.employers) {
      await tx.insert(demoEmployers).values(e).onConflictDoUpdate({
        target: demoEmployers.id,
        set: { ...e, updatedAt: now },
      });
    }
    for (const j of seed.jobs) {
      await tx.insert(demoJobs).values(j).onConflictDoUpdate({
        target: demoJobs.id,
        set: { ...j, ...idle, updatedAt: now },
      });
    }
    for (const c of seed.candidates) {
      await tx.insert(demoCandidates).values(c).onConflictDoUpdate({
        target: demoCandidates.key,
        set: { ...c, ...idle, updatedAt: now },
      });
    }
    for (const s of seed.spend) {
      await tx
        .insert(museSpendBudgets)
        .values({ ...s, capMicroUsd: Math.round(CANDIDATE_SPEND_CAP_USD * 1e6) })
        .onConflictDoUpdate({
          target: museSpendBudgets.scope,
          set: {
            spentMicroUsd: sql`greatest(${museSpendBudgets.spentMicroUsd}, excluded.spent_micro_usd)`,
            updatedAt: now,
          },
        });
    }
    let inserted = 0;
    for (const a of seed.assessments) {
      // Each run is its own row; the same saved run is never added twice.
      const [existing] = await tx
        .select({ id: skillAssessments.id })
        .from(skillAssessments)
        .where(
          and(
            eq(skillAssessments.kind, a.kind),
            eq(skillAssessments.subjectKind, a.subjectKind),
            eq(skillAssessments.subjectKey, a.subjectKey),
            eq(skillAssessments.cacheKey, a.cacheKey),
            a.completedAt === null
              ? sql`${skillAssessments.completedAt} is null`
              : eq(skillAssessments.completedAt, a.completedAt),
          ),
        );
      if (existing) continue;
      const schema = a.kind === 'candidate' ? CandidateAssessmentSchema : JobAssessmentSchema;
      await tx.insert(skillAssessments).values({ ...a, result: schema.parse(a.result) });
      inserted++;
    }
    return inserted;
  });
  console.log(
    `Loaded ${seed.employers.length} employers, ${seed.jobs.length} jobs, ` +
      `${seed.candidates.length} candidates, ${seed.spend.length} seeker spend record(s); ` +
      `added ${added} of ${seed.assessments.length} saved analyses.`,
  );
}

const command = process.argv[2];
try {
  if (command === 'export') await exportSeed();
  else if (command === 'load') await loadSeed();
  else {
    console.error('Usage: demo:seed export|load');
    process.exitCode = 1;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : 'Seed command failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
