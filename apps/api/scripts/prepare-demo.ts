// Prepares demo inputs from saved fixtures. Calls GitHub only; never calls Muse.
//   pnpm --filter @clearhire/api exec tsx scripts/prepare-demo.ts candidate (--id <curated key> | --login <login>)
//     [--repo <owner/name> ...] [--resume <file>] --data-use approved_public_demo|restricted
//   pnpm --filter @clearhire/api exec tsx scripts/prepare-demo.ts jobs --data-use approved_public_demo|restricted
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import type { PreparedJob } from '../src/lib/assessments.js';
import {
  serializePreparedCandidate,
  type PreparedCandidate,
} from '../src/lib/candidate-evidence.js';
import { readDemoFiles } from '../src/lib/demo-import.js';
import { demoOctokit, prepareRepo, type SelectedRepo } from '../src/lib/demo-prepare.js';

const root = (path: string) => new URL(`../../../${path}`, import.meta.url);
const PREPARED = root('data/demo/prepared/');
const demoData = () => readDemoFiles(fileURLToPath(root(''))).data;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    id: { type: 'string' },
    login: { type: 'string' },
    repo: { type: 'string', multiple: true },
    resume: { type: 'string' },
    'data-use': { type: 'string' },
  },
});

const dataUse = z.enum(['approved_public_demo', 'restricted']).safeParse(values['data-use']);
if (!dataUse.success) fail('--data-use must be approved_public_demo or restricted');

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Curated profiles keep their established keys and pinned selections (validated on import). */
function curatedProfile(key: string) {
  const candidate = demoData().candidates.find((c) => c.key === key);
  if (!candidate) fail(`No curated profile with key ${key}`);
  return {
    key: candidate.key,
    login: candidate.githubLogin,
    selections: candidate.repositories,
    source: { file: 'curated-profiles.json', profile: candidate.raw },
  };
}

async function prepareCandidate() {
  const octokit = demoOctokit();
  const chosen = values.id
    ? curatedProfile(values.id)
    : values.login
      ? { key: values.login, login: values.login, selections: [], source: { manual: true } }
      : fail('Pass --id or --login');
  // Explicit --repo values override the saved selection; saved pins still apply.
  const selections: SelectedRepo[] = values.repo
    ? values.repo.map((full) => {
        const [owner, repo] = full.split('/');
        if (!owner || !repo) fail(`Invalid repository: ${full}`);
        const saved = chosen.selections.find(
          (s) => `${s.owner}/${s.repo}`.toLowerCase() === full.toLowerCase(),
        );
        return { owner, repo, pinnedSha: saved?.pinnedSha ?? null };
      })
    : chosen.selections;
  if (selections.length === 0) fail('Pass at least one --repo owner/name');

  const { data: user } = await octokit.rest.users.getByUsername({ username: chosen.login });
  const identity = { githubUserId: user.id, login: user.login, verifiedEmails: [] };
  const prepared: PreparedCandidate['repos'] = [];
  for (const selection of selections) {
    const entry = await prepareRepo(octokit, selection, identity);
    prepared.push(entry);
    const name = `${selection.owner}/${selection.repo}`;
    console.log(
      'unavailable' in entry
        ? `${name}: unavailable (${entry.unavailable})`
        : `${name}: ${entry.snapshot.files.length} files at ${entry.snapshot.commitSha.slice(0, 7)}`,
    );
  }

  const resume = values.resume ? { text: readFileSync(values.resume, 'utf8') } : null;
  const candidate: PreparedCandidate = {
    subject: { kind: 'demo', key: chosen.key },
    identity,
    repos: prepared,
    resume,
    dataUse: dataUse.data!,
  };
  mkdirSync(new URL('candidates/', PREPARED), { recursive: true });
  const out = new URL(`candidates/${chosen.key}.json`, PREPARED);
  writeFileSync(out, serializePreparedCandidate(candidate, chosen.source));
  console.log(`Wrote ${out.pathname}`);
}

/** Same job text as the importer: a saved full description, otherwise the abbreviated summary. */
function prepareJobs() {
  mkdirSync(new URL('jobs/', PREPARED), { recursive: true });
  for (const job of demoData().jobs) {
    const prepared: PreparedJob & { source: unknown } = {
      jobKey: job.id,
      employerId: job.employerId,
      title: job.title,
      text: job.text,
      textSource: job.textSource,
      dataUse: dataUse.data!,
      source: { sourceUrl: job.sourceUrl, scenario: job.scenario },
    };
    writeFileSync(new URL(`jobs/${job.id}.json`, PREPARED), JSON.stringify(prepared, null, 2));
    console.log(`${job.id}: ${prepared.textSource}`);
  }
}

if (positionals[0] === 'candidate') await prepareCandidate();
else if (positionals[0] === 'jobs') prepareJobs();
else fail('Usage: prepare-demo.ts candidate|jobs ...');
