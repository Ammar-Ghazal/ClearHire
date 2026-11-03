// Manual, paid evaluation command. Runs one live analysis at a time (repositories are fetched from
// GitHub and held only in memory) and prints the result and spend.
//   pnpm --filter @clearhire/api exec tsx scripts/muse-run.ts candidate <demo key> [--retry] [--fresh]
//   pnpm --filter @clearhire/api exec tsx scripts/muse-run.ts job <job id> [--retry] [--fresh]
//   pnpm --filter @clearhire/api exec tsx scripts/muse-run.ts match <demo key> <job id>
//   pnpm --filter @clearhire/api exec tsx scripts/muse-run.ts recover
import { CandidateAssessmentSchema, JobAssessmentSchema } from '@clearhire/shared';
import { and, desc, eq } from 'drizzle-orm';
import { parseArgs } from 'node:util';
import { pool, db } from '../src/db/client.js';
import { demoCandidates, demoJobs, museCalls, skillAssessments } from '../src/db/schema.js';
import { env, museConfigured } from '../src/env.js';
import { matchSaved, recoverStaleAssessments } from '../src/lib/assessments.js';
import { safeErrorCode, startCandidateRun, startJobRun } from '../src/lib/demo-runner.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { retry: { type: 'boolean' }, fresh: { type: 'boolean' } },
});
const [command, first, second] = positionals;
const start = { retry: values.retry ?? false, fresh: values.fresh ?? false };
const onError = (err: unknown) => console.error(`Run failed: ${safeErrorCode(err)}`);

async function latest(kind: 'candidate' | 'job', key: string) {
  const [row] = await db
    .select()
    .from(skillAssessments)
    .where(and(eq(skillAssessments.kind, kind), eq(skillAssessments.subjectKey, key)))
    .orderBy(desc(skillAssessments.startedAt))
    .limit(1);
  return row;
}

async function report(assessmentId: string, cached: boolean) {
  const calls = await db.select().from(museCalls).where(eq(museCalls.assessmentId, assessmentId));
  console.log(
    `model ${env.META_MODEL}; ${cached ? 'cached result, no new call' : `${calls.length} attempt(s)`}`,
  );
  for (const c of calls) {
    console.log(
      `  attempt ${c.attempt}: ${c.settlement} ${c.costSource ?? ''} ` +
        `$${((c.costMicroUsd ?? c.reservedMicroUsd) / 1e6).toFixed(4)} http=${c.httpStatus ?? '-'} ` +
        `finish=${c.finishReason ?? '-'} prompt=${c.promptTokens ?? '-'} cached=${c.cachedTokens ?? '-'} ` +
        `completion=${c.completionTokens ?? '-'} reasoning=${c.reasoningTokens ?? '-'} error=${c.errorCode ?? '-'}`,
    );
  }
}

try {
  if (command === 'recover') {
    console.log(`Recovered ${await recoverStaleAssessments()} stale assessment(s)`);
  } else if (!museConfigured) {
    throw new Error('Set META_API_KEY and META_MODEL in .env first');
  } else if (command === 'candidate' && first) {
    const run = await startCandidateRun(first, start, { onError });
    await run.done;
    const [subject] = await db.select().from(demoCandidates).where(eq(demoCandidates.key, first));
    const row = await latest('candidate', first);
    if (subject?.runStatus === 'failed' || !row || row.status === 'failed') {
      throw new Error(`Analysis failed (${subject?.runError ?? row?.errorCode ?? 'unknown'})`);
    }
    const assessment = CandidateAssessmentSchema.parse(row.result);
    console.log(`${assessment.status}; evidence ${assessment.coverage.evidence}`);
    console.log(
      `  ${assessment.skills.length} supported skill(s), ${assessment.unsupportedSkills.length} unsupported, ` +
        `${assessment.coverage.omissions.length} omission(s), ` +
        `${assessment.coverage.unavailableRepos.length} unavailable repo(s)`,
    );
    for (const r of row.inputManifest?.repos ?? []) {
      console.log(`  ${r.repo} @ ${r.commitSha?.slice(0, 7) ?? `unavailable (${r.unavailable})`}`);
    }
    for (const s of assessment.skills) console.log(`  ${s.skillId} L${s.level} (${s.confidence})`);
    await report(row.id, run.result === 'cached');
  } else if (command === 'job' && first) {
    const run = await startJobRun(first, start, { onError });
    await run.done;
    const [subject] = await db.select().from(demoJobs).where(eq(demoJobs.id, first));
    const row = await latest('job', first);
    if (subject?.runStatus === 'failed' || !row || row.status === 'failed') {
      throw new Error(`Analysis failed (${subject?.runError ?? row?.errorCode ?? 'unknown'})`);
    }
    const assessment = JobAssessmentSchema.parse(row.result);
    console.log(
      `${assessment.inScope ? 'in scope' : `out of scope: ${assessment.outOfScopeReason}`}`,
    );
    for (const r of assessment.requirements) {
      console.log(`  ${r.skillId} L${r.requiredLevel} priority ${r.suggestedPriority}`);
    }
    await report(row.id, run.result === 'cached');
  } else if (command === 'match' && first && second) {
    console.log(JSON.stringify(await matchSaved({ kind: 'demo', key: first }, second), null, 2));
  } else {
    throw new Error('Usage: muse-run.ts candidate <key> | job <id> | match <key> <id> | recover');
  }
} catch (err) {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : 'Failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
