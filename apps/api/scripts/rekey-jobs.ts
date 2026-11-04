// One-time: moves saved posting results whose inputs and grading rules are proven unchanged to the
// new job key (see src/lib/job-rekey.ts). Dry run by default; nothing is sent to Muse.
//   pnpm --filter @clearhire/api exec tsx scripts/rekey-jobs.ts [--apply]
import { pool } from '../src/db/client.js';
import { env } from '../src/env.js';
import { rekeyJobs } from '../src/lib/job-rekey.js';

const apply = process.argv.includes('--apply');
try {
  if (!env.META_MODEL) throw new Error('META_MODEL is not set');
  const outcomes = await rekeyJobs({ model: env.META_MODEL, apply });
  for (const o of outcomes.sort((a, b) => a.jobKey.localeCompare(b.jobKey))) {
    const what = o.skipped ? `skipped (${o.skipped})` : apply ? 'rekeyed' : 'reusable';
    console.log(`${o.jobKey}  ${what}  ${o.oldKey.slice(0, 12)} -> ${o.newKey.slice(0, 12)}`);
  }
  const ok = outcomes.filter((o) => o.skipped === null).length;
  console.log(`${ok} ${apply ? 'rekeyed' : 'reusable'}, ${outcomes.length - ok} skipped.`);
} finally {
  await pool.end();
}
