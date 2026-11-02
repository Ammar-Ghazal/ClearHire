// Imports the saved demo fixtures and local resume PDFs into Postgres. Never calls GitHub or Muse.
//   pnpm --filter @clearhire/api demo:import            validate, extract changed PDFs, import
//   pnpm --filter @clearhire/api demo:import --check    validate and extract every PDF; no writes
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { pool } from '../src/db/client.js';
import {
  DemoImportError,
  extractChangedResumes,
  importDemoData,
  readDemoFiles,
  storedResumeHashes,
} from '../src/lib/demo-import.js';

const { values } = parseArgs({ options: { check: { type: 'boolean', default: false } } });
const root = fileURLToPath(new URL('../../../', import.meta.url));

try {
  const bundle = readDemoFiles(root);
  const { employers, jobs, candidates } = bundle.data;
  console.log(
    `Valid: ${employers.length} employers, ${jobs.length} jobs ` +
      `(${jobs.filter((j) => !j.inScope).length} out of scope), ${candidates.length} candidates, ` +
      `${bundle.pdfs.size} resume PDFs, ${bundle.prepared.size} prepared files`,
  );
  const keys = candidates.map((c) => c.key);
  const stored = values.check ? new Map<string, string | null>() : await storedResumeHashes(keys);
  const extractions = await extractChangedResumes(bundle, stored);
  for (const [key, result] of extractions) {
    console.log(
      result.status === 'extracted'
        ? `  ${key}: extracted ${result.pages} page(s)`
        : `  ${key}: needs review (${result.reason})`,
    );
  }
  if (values.check) {
    const flagged = [...extractions.values()].filter((r) => r.status !== 'extracted').length;
    console.log(`Check complete: ${extractions.size - flagged} readable, ${flagged} need review.`);
  } else {
    const stats = await importDemoData(bundle, extractions);
    for (const table of ['employers', 'jobs', 'candidates'] as const) {
      const s = stats[table];
      console.log(
        `${table}: ${s.inserted} inserted, ${s.updated} updated, ${s.unchanged} unchanged`,
      );
    }
    if (stats.overridesCleared > 0) {
      console.log(`Cleared ${stats.overridesCleared} priority override(s) for changed postings.`);
    }
  }
} catch (err) {
  if (!(err instanceof DemoImportError)) throw err;
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
