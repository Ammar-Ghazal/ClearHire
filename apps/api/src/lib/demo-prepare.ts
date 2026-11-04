// Fetches a demo candidate's selected repositories for one run. The result lives only in memory:
// repository code is never stored, so every run fetches the current default-branch commit again.
// Never runs Muse.
import { Octokit } from '@octokit/rest';
import { env } from '../env.js';
import type { CandidateIdentity } from './attribution.js';
import type { PreparedCandidate, PreparedRepo, UnavailableRepo } from './candidate-evidence.js';
import { collectContributions } from './contributions.js';
import { ingestRepo, toIngestError } from './ingest.js';

export interface SelectedRepo {
  owner: string;
  repo: string;
  /** Commit recorded during research; provenance only, runs grade the default-branch head. */
  pinnedSha: string | null;
}

export interface DemoCandidateInput {
  key: string;
  githubLogin: string;
  repositories: SelectedRepo[];
  /** Current extracted resume text, or null when absent or flagged for review. */
  resumeText: string | null;
}

/** GitHub failures worth one explicit retry; the rest describe the repository itself. */
export const TRANSIENT = new Set([
  'rate_limited',
  'timeout',
  'upstream_error',
  'count_unavailable',
]);

export const fullName = (r: { owner: string; repo: string }) => `${r.owner}/${r.repo}`;

/** A heartbeat older than this means the run's worker is gone. */
export const RUN_STALE_MS = 120_000;

/**
 * GitHub's secondary limit is 900 REST points a minute (a GET is 1), shared by every concurrent
 * run on the demo token, so request starts are spaced to stay under 800 a minute.
 * https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
 */
export const GITHUB_REQUEST_GAP_MS = 60_000 / 800;
let nextRequestAt = 0;

export async function paceGitHubRequest(now = Date.now()): Promise<void> {
  const at = Math.max(now, nextRequestAt);
  nextRequestAt = at + GITHUB_REQUEST_GAP_MS;
  if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
}

export function demoOctokit(): Octokit {
  const octokit = new Octokit(env.GITHUB_DEMO_TOKEN ? { auth: env.GITHUB_DEMO_TOKEN } : {});
  octokit.hook.before('request', () => paceGitHubRequest());
  return octokit;
}

/** Ingests one selection at its default-branch head; failures become an unavailable entry. */
export async function prepareRepo(
  octokit: Octokit,
  selection: Pick<SelectedRepo, 'owner' | 'repo'>,
  identity: CandidateIdentity,
): Promise<PreparedRepo | UnavailableRepo> {
  const { owner, repo } = selection;
  try {
    const snapshot = await ingestRepo(octokit, { owner, repo });
    const collected = await collectContributions(
      octokit,
      { owner, repo, commitSha: snapshot.commitSha },
      identity,
      snapshot.files.map((f) => f.path),
    );
    return { owner, repo, collectedFor: identity.githubUserId, snapshot, collected };
  } catch (err) {
    const reason = toIngestError(err, 'prepare', new AbortController().signal).code;
    return { owner, repo, unavailable: reason };
  }
}

export class PreparationError extends Error {
  constructor(readonly code: 'identity_mismatch' | 'organization_account') {
    super(
      code === 'identity_mismatch'
        ? 'The GitHub account does not match the profile login'
        : 'Organization accounts are not analysed as a person',
    );
  }
}

/** The GitHub identity behind a demo login; organizations are never analysed as a person. */
export async function resolveIdentity(octokit: Octokit, login: string): Promise<CandidateIdentity> {
  let user;
  try {
    ({ data: user } = await octokit.rest.users.getByUsername({ username: login }));
  } catch (err) {
    throw toIngestError(err, 'getUser', new AbortController().signal);
  }
  if (user.login.toLowerCase() !== login.toLowerCase()) {
    throw new PreparationError('identity_mismatch');
  }
  if (user.type === 'Organization') throw new PreparationError('organization_account');
  return { githubUserId: user.id, login: user.login, verifiedEmails: [] };
}

/** Fetches every selected repository and attaches the current resume text. */
export async function prepareDemoCandidate(
  octokit: Octokit,
  candidate: DemoCandidateInput,
): Promise<PreparedCandidate> {
  const identity = await resolveIdentity(octokit, candidate.githubLogin);
  const repos: (PreparedRepo | UnavailableRepo)[] = [];
  for (const sel of candidate.repositories) repos.push(await prepareRepo(octokit, sel, identity));
  return {
    subject: { kind: 'demo', key: candidate.key },
    identity,
    repos,
    resume: candidate.resumeText === null ? null : { text: candidate.resumeText },
    dataUse: 'approved_public_demo',
  };
}
