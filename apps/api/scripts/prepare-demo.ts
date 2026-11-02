// Prepares demo inputs from saved fixtures. Calls GitHub only; never calls Muse.
//   pnpm --filter @clearhire/api exec tsx scripts/prepare-demo.ts candidate (--id <curated id> | --login <login>)
//     --repo <owner/name> [--repo ...] [--resume <file>] --data-use approved_public_demo|restricted
//   pnpm --filter @clearhire/api exec tsx scripts/prepare-demo.ts jobs --data-use approved_public_demo|restricted
import { Octokit } from '@octokit/rest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { env } from '../src/env.js';
import { collectContributions } from '../src/lib/contributions.js';
import {
  serializePreparedCandidate,
  type PreparedCandidate,
  type PreparedRepo,
  type UnavailableRepo,
} from '../src/lib/candidate-evidence.js';
import { ingestRepo, toIngestError } from '../src/lib/ingest.js';
import type { PreparedJob } from '../src/lib/assessments.js';

const root = (path: string) => new URL(`../../../${path}`, import.meta.url);
const CURATED = root('data/demo/public-developers/curated-profiles.json');
const PREPARED = root('data/demo/prepared/');

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

const loginFromUrl = (url: unknown) =>
  typeof url === 'string' ? /github\.com\/([^/?#]+)/.exec(url)?.[1] : undefined;

/** The curated collection is the only candidate source; its records keep their stable IDs. */
function curatedProfile(id: string) {
  if (!existsSync(CURATED)) {
    fail(
      'curated-profiles.json is missing: restore it, or prepare with --login and explicit --repo values',
    );
  }
  const parsed = z
    .object({ profiles: z.array(z.object({ id: z.string().optional() }).passthrough()) })
    .safeParse(JSON.parse(readFileSync(CURATED, 'utf8')));
  if (!parsed.success) fail('curated-profiles.json does not contain a profiles array');
  const profile = parsed.data.profiles.find(
    (p) => p.id === id || (p.id === undefined && loginFromUrl(p.github_url) === id),
  );
  if (!profile) fail(`No curated profile with id ${id}`);
  const login = loginFromUrl(profile.github_url);
  if (!login) fail(`Curated profile ${id} has no GitHub URL`);
  // Saved selections are pinned to the commit recorded during research.
  const selections = z
    .array(
      z
        .object({
          full_name: z.string(),
          pinned_commit_sha: z.string().optional(),
          commit_sha: z.string().optional(),
        })
        .passthrough(),
    )
    .catch([])
    .parse(profile.selected_repositories);
  const pins = new Map(
    selections.flatMap((r) => {
      const sha = r.pinned_commit_sha ?? r.commit_sha;
      return sha ? [[r.full_name.toLowerCase(), sha] as const] : [];
    }),
  );
  return {
    key: profile.id ?? login,
    login,
    pins,
    source: { file: 'curated-profiles.json', profile },
  };
}

async function prepareCandidate() {
  const octokit = new Octokit(env.GITHUB_DEMO_TOKEN ? { auth: env.GITHUB_DEMO_TOKEN } : {});
  const chosen = values.id
    ? curatedProfile(values.id)
    : values.login
      ? {
          key: values.login,
          login: values.login,
          pins: new Map<string, string>(),
          source: { manual: true },
        }
      : fail('Pass --id or --login');
  const repos = values.repo ?? fail('Pass at least one --repo owner/name');

  const { data: user } = await octokit.rest.users.getByUsername({ username: chosen.login });
  const identity = { githubUserId: user.id, login: user.login, verifiedEmails: [] };
  const prepared: PreparedCandidate['repos'] = [];
  for (const full of repos) {
    const [owner, repo] = full.split('/');
    if (!owner || !repo) fail(`Invalid repository: ${full}`);
    try {
      const ref = chosen.pins.get(full.toLowerCase());
      const snapshot = await ingestRepo(octokit, { owner, repo, ...(ref && { ref }) });
      const collected = await collectContributions(
        octokit,
        { owner, repo, commitSha: snapshot.commitSha },
        identity,
      );
      prepared.push({
        owner,
        repo,
        collectedFor: identity.githubUserId,
        snapshot,
        collected,
      } satisfies PreparedRepo);
      console.log(`${full}: ${snapshot.files.length} files at ${snapshot.commitSha.slice(0, 7)}`);
    } catch (err) {
      const reason = toIngestError(err, 'prepare', new AbortController().signal).code;
      prepared.push({ owner, repo, unavailable: reason } satisfies UnavailableRepo);
      console.log(`${full}: unavailable (${reason})`);
    }
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

const EmployerSchema = z.object({ id: z.string(), name: z.string() }).passthrough();
const JobSchema = z
  .object({
    id: z.string(),
    employer_id: z.string(),
    title: z.string(),
    requirements_summary: z.array(z.string()),
    source_url: z.string(),
    scenario: z.string(),
  })
  .passthrough();

/** Uses a saved full description when one exists; otherwise the abbreviated fixture summary. */
function prepareJobs() {
  const employers = z
    .array(EmployerSchema)
    .parse(JSON.parse(readFileSync(root('data/demo/employers/employers.json'), 'utf8')));
  const jobs = z
    .array(JobSchema)
    .parse(JSON.parse(readFileSync(root('data/demo/employers/jobs.json'), 'utf8')));
  const byId = new Map(employers.map((e) => [e.id, e]));
  mkdirSync(new URL('jobs/', PREPARED), { recursive: true });
  for (const job of jobs) {
    const employer =
      byId.get(job.employer_id) ?? fail(`${job.id}: unknown employer ${job.employer_id}`);
    const descriptionFile = root(`data/demo/employers/descriptions/${job.id}.txt`);
    const full = existsSync(descriptionFile);
    const text = full
      ? readFileSync(descriptionFile, 'utf8')
      : [
          `${job.title} at ${employer.name}`,
          'Abbreviated research notes, not the full job description:',
          ...job.requirements_summary,
        ].join('\n');
    const prepared: PreparedJob & { source: unknown } = {
      jobKey: job.id,
      employerId: employer.id,
      title: job.title,
      text,
      textSource: full ? 'full_description' : 'fixture_summary',
      dataUse: dataUse.data!,
      source: { sourceUrl: job.source_url, scenario: job.scenario, employer: employer.name },
    };
    writeFileSync(new URL(`jobs/${job.id}.json`, PREPARED), JSON.stringify(prepared, null, 2));
    console.log(`${job.id}: ${prepared.textSource}`);
  }
}

if (positionals[0] === 'candidate') await prepareCandidate();
else if (positionals[0] === 'jobs') prepareJobs();
else fail('Usage: prepare-demo.ts candidate|jobs ...');
