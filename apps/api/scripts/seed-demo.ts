// Exports or loads the demo seed: imported fixtures plus their saved analyses, so the demo runs on
// a fresh database without GitHub, Muse, the gitignored prepared files or the résumé PDFs.
//   pnpm --filter @clearhire/api demo:seed export   write data/demo/seed/demo-seed.json from this database
//   pnpm --filter @clearhire/api demo:seed load     upsert the fixtures and add the saved analyses
// Loading never calls GitHub or Muse and never touches relationships, offers or other workflow rows.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray, or } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { demoCandidates, demoEmployers, demoJobs, skillAssessments } from '../src/db/schema.js';

const FILE = fileURLToPath(new URL('../../../data/demo/seed/demo-seed.json', import.meta.url));
const SAVED = ['complete', 'partial', 'no_attributed_evidence'] as const;

type Employer = typeof demoEmployers.$inferInsert;
type Job = typeof demoJobs.$inferInsert;
type Candidate = typeof demoCandidates.$inferInsert;
type Assessment = typeof skillAssessments.$inferInsert;
interface Seed {
  employers: Employer[];
  jobs: Job[];
  candidates: Candidate[];
  assessments: Assessment[];
}

// Run state and timestamps are local to one database; a loaded subject starts idle.
const local = ['runId', 'runStatus', 'runError', 'runHeartbeatAt', 'updatedAt'] as const;
const strip = <T extends object>(row: T) =>
  Object.fromEntries(Object.entries(row).filter(([k]) => !(local as readonly string[]).includes(k)));

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
  const seed = {
    employers: employers.map(strip),
    jobs: jobs.map(strip),
    candidates: candidates.map(strip),
    // The id is local; the cache key identifies a saved analysis.
    assessments: assessments.map(({ id: _id, ...a }) => a),
  };
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, `${JSON.stringify(seed, null, 1)}\n`);
  const count = (kind: string) => assessments.filter((a) => a.kind === kind).length;
  console.log(
    `Wrote ${FILE}: ${employers.length} employers, ${jobs.length} jobs, ` +
      `${candidates.length} candidates, ${count('candidate')} candidate and ${count('job')} job analyses.`,
  );
}

const dates = (a: Assessment): Assessment => ({
  ...a,
  startedAt: a.startedAt && new Date(a.startedAt),
  heartbeatAt: a.heartbeatAt && new Date(a.heartbeatAt),
  completedAt: a.completedAt && new Date(a.completedAt),
});

async function loadSeed() {
  const seed = JSON.parse(readFileSync(FILE, 'utf8')) as Seed;
  const added = await db.transaction(async (tx) => {
    const now = new Date();
    for (const e of seed.employers) {
      await tx.insert(demoEmployers).values(e).onConflictDoUpdate({
        target: demoEmployers.id,
        set: { ...e, updatedAt: now },
      });
    }
    for (const j of seed.jobs) {
      await tx.insert(demoJobs).values(j).onConflictDoUpdate({
        target: demoJobs.id,
        set: { ...j, runStatus: 'idle', runId: null, runError: null, updatedAt: now },
      });
    }
    for (const c of seed.candidates) {
      await tx.insert(demoCandidates).values(c).onConflictDoUpdate({
        target: demoCandidates.key,
        set: { ...c, runStatus: 'idle', runId: null, runError: null, updatedAt: now },
      });
    }
    if (seed.assessments.length === 0) return 0;
    const inserted = await tx
      .insert(skillAssessments)
      .values(seed.assessments.map(dates))
      .onConflictDoNothing({ target: skillAssessments.cacheKey })
      .returning({ id: skillAssessments.id });
    return inserted.length;
  });
  console.log(
    `Loaded ${seed.employers.length} employers, ${seed.jobs.length} jobs, ` +
      `${seed.candidates.length} candidates; added ${added} of ${seed.assessments.length} saved analyses.`,
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
} finally {
  await pool.end();
}
