// Manual, paid evaluation command. Runs one analysis at a time and prints coverage and spend.
//   pnpm --filter @clearhire/api exec tsx scripts/muse-run.ts candidate <prepared key> [--retry] [--ceiling N]
//   pnpm --filter @clearhire/api exec tsx scripts/muse-run.ts job <job id> [--retry]
//   pnpm --filter @clearhire/api exec tsx scripts/muse-run.ts match <demo key> <job id>
//   pnpm --filter @clearhire/api exec tsx scripts/muse-run.ts recover
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pool, db } from '../src/db/client.js';
import { museCalls } from '../src/db/schema.js';
import { env, museConfigured } from '../src/env.js';
import {
  analyzeCandidate,
  analyzeJob,
  matchSaved,
  recoverStaleAssessments,
  type PreparedJob,
} from '../src/lib/assessments.js';
import { parsePreparedCandidate } from '../src/lib/candidate-evidence.js';

const PREPARED = new URL('../../../data/demo/prepared/', import.meta.url);
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { retry: { type: 'boolean' }, ceiling: { type: 'string' } },
});
const [command, first, second] = positionals;

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
    const prepared = parsePreparedCandidate(
      JSON.parse(readFileSync(new URL(`candidates/${first}.json`, PREPARED), 'utf8')),
    );
    const { assessmentId, assessment, cached } = await analyzeCandidate(prepared, {
      retryFailed: values.retry ?? false,
      ...(values.ceiling && { inputTokenCeiling: Number(values.ceiling) }),
    });
    console.log(`${assessment.status}; evidence ${assessment.coverage.evidence}`);
    console.log(
      `  ${assessment.skills.length} supported skill(s), ${assessment.unsupportedSkills.length} unsupported, ` +
        `${assessment.coverage.omissions.length} omission(s), ` +
        `${assessment.coverage.unavailableRepos.length} unavailable repo(s)`,
    );
    for (const s of assessment.skills) console.log(`  ${s.skillId} L${s.level} (${s.confidence})`);
    await report(assessmentId, cached);
  } else if (command === 'job' && first) {
    const job = JSON.parse(
      readFileSync(new URL(`jobs/${first}.json`, PREPARED), 'utf8'),
    ) as PreparedJob;
    const { assessmentId, assessment, cached } = await analyzeJob(job, {
      retryFailed: values.retry ?? false,
    });
    console.log(
      `${assessment.inScope ? 'in scope' : `out of scope: ${assessment.outOfScopeReason}`}`,
    );
    for (const r of assessment.requirements) {
      console.log(`  ${r.skillId} L${r.requiredLevel} priority ${r.suggestedPriority}`);
    }
    await report(assessmentId, cached);
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
