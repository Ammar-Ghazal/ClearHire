// Demo candidate inputs. `effectiveInput` is the single builder used by result reads, matching and
// the runner, so a changed selection, pin or resume can never leave an old result looking current.
// `prepareDemoCandidate` fetches only what is missing or invalid; it never runs Muse.
import { Octokit } from '@octokit/rest';
import { env } from '../env.js';
import type { CandidateIdentity } from './attribution.js';
import type { PreparedCandidate, PreparedRepo, UnavailableRepo } from './candidate-evidence.js';
import { collectContributions } from './contributions.js';
import { ingestRepo, toIngestError } from './ingest.js';

export interface SelectedRepo {
  owner: string;
  repo: string;
  /** Commit recorded during research; snapshots are never advanced past it. */
  pinnedSha: string | null;
}

export interface DemoCandidateInput {
  key: string;
  githubLogin: string;
  repositories: SelectedRepo[];
  /** Current extracted resume text, or null when absent or flagged for review. */
  resumeText: string | null;
}

export type EffectiveInput =
  | { kind: 'ready'; prepared: PreparedCandidate }
  | { kind: 'not_prepared'; missing: SelectedRepo[] };

/** GitHub failures worth one explicit retry; the rest describe the repository itself. */
const TRANSIENT = new Set(['rate_limited', 'timeout', 'upstream_error']);

type Entry = PreparedRepo | UnavailableRepo;
const isAvailable = (r: Entry): r is PreparedRepo => !('unavailable' in r);
const sameRepo = (a: { owner: string; repo: string }, b: { owner: string; repo: string }) =>
  a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();
export const fullName = (r: { owner: string; repo: string }) => `${r.owner}/${r.repo}`;

/** A heartbeat older than this means the run's worker is gone. */
export const RUN_STALE_MS = 120_000;

export function identityMatches(
  candidate: Pick<DemoCandidateInput, 'key' | 'githubLogin'>,
  prepared: PreparedCandidate,
): boolean {
  return (
    prepared.subject.kind === 'demo' &&
    prepared.subject.key === candidate.key &&
    prepared.identity.login.toLowerCase() === candidate.githubLogin.toLowerCase()
  );
}

/**
 * Unavailable entries are valid incomplete evidence for the pin they were fetched for (entries
 * without a recorded pin predate it and are fetched again); available ones must match pin and owner.
 */
function entryValid(entry: Entry, selection: SelectedRepo, identity: CandidateIdentity): boolean {
  if (!isAvailable(entry)) return entry.requestedSha === selection.pinnedSha;
  const meta = entry.collected.repository;
  return (
    (selection.pinnedSha === null || entry.snapshot.commitSha === selection.pinnedSha) &&
    entry.collectedFor === identity.githubUserId &&
    meta.commitSha === entry.snapshot.commitSha &&
    sameRepo(meta, entry)
  );
}

function validEntry(prepared: PreparedCandidate, sel: SelectedRepo) {
  const entry = prepared.repos.find((r) => sameRepo(r, sel));
  return entry && entryValid(entry, sel, prepared.identity) ? entry : undefined;
}

export function effectiveInput(
  candidate: DemoCandidateInput,
  prepared: PreparedCandidate | null,
): EffectiveInput {
  if (!prepared || !identityMatches(candidate, prepared)) {
    return { kind: 'not_prepared', missing: candidate.repositories };
  }
  const missing = candidate.repositories.filter((sel) => !validEntry(prepared, sel));
  if (missing.length > 0) return { kind: 'not_prepared', missing };
  // Keeps the prepared order, so unchanged inputs keep their existing cache keys.
  const repos = prepared.repos.filter((r) =>
    candidate.repositories.some((sel) => sameRepo(r, sel)),
  );
  const resume = candidate.resumeText === null ? null : { text: candidate.resumeText };
  return { kind: 'ready', prepared: { ...prepared, repos, resume } };
}

export const transientRepos = (prepared: PreparedCandidate): string[] =>
  prepared.repos.flatMap((r) =>
    !isAvailable(r) && TRANSIENT.has(r.unavailable) ? [fullName(r)] : [],
  );

export function demoOctokit(): Octokit {
  return new Octokit(env.GITHUB_DEMO_TOKEN ? { auth: env.GITHUB_DEMO_TOKEN } : {});
}

/** Ingests one pinned selection; GitHub failures become an unavailable entry, never a throw. */
export async function prepareRepo(
  octokit: Octokit,
  selection: SelectedRepo,
  identity: CandidateIdentity,
): Promise<Entry> {
  const { owner, repo, pinnedSha } = selection;
  try {
    const ref = pinnedSha ?? undefined;
    const snapshot = await ingestRepo(octokit, { owner, repo, ...(ref && { ref }) });
    const collected = await collectContributions(
      octokit,
      { owner, repo, commitSha: snapshot.commitSha },
      identity,
    );
    return { owner, repo, collectedFor: identity.githubUserId, snapshot, collected };
  } catch (err) {
    const reason = toIngestError(err, 'prepare', new AbortController().signal).code;
    return { owner, repo, unavailable: reason, requestedSha: pinnedSha };
  }
}

export class PreparationError extends Error {
  constructor(readonly code: 'identity_mismatch') {
    super('The GitHub account does not match the profile login');
  }
}

/**
 * Brings a preparation up to date: drops deselected repositories, keeps valid entries, and fetches
 * only missing or invalid selections (plus transient failures when `refetchTransient` is set).
 * The resume is never stored here; `effectiveInput` attaches the current text.
 */
export async function prepareDemoCandidate(
  octokit: Octokit,
  candidate: DemoCandidateInput,
  existing: PreparedCandidate | null,
  options: { refetchTransient: boolean },
): Promise<PreparedCandidate> {
  const base = existing && identityMatches(candidate, existing) ? existing : null;
  let identity = base?.identity;
  if (!identity) {
    const { data: user } = await octokit.rest.users.getByUsername({
      username: candidate.githubLogin,
    });
    if (user.login.toLowerCase() !== candidate.githubLogin.toLowerCase()) {
      throw new PreparationError('identity_mismatch');
    }
    identity = { githubUserId: user.id, login: user.login, verifiedEmails: [] };
  }
  const repos: Entry[] = [];
  for (const sel of candidate.repositories) {
    const entry = base ? validEntry(base, sel) : undefined;
    const refetch =
      entry !== undefined &&
      options.refetchTransient &&
      !isAvailable(entry) &&
      TRANSIENT.has(entry.unavailable);
    repos.push(entry && !refetch ? entry : await prepareRepo(octokit, sel, identity));
  }
  return {
    subject: { kind: 'demo', key: candidate.key },
    identity,
    repos,
    resume: null,
    dataUse: base?.dataUse ?? 'approved_public_demo',
  };
}
