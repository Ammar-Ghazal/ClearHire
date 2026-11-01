// Bounded Octokit collection of commit evidence for one candidate at a pinned commit. Required steps
// fail the run; optional PR enrichment stops at the request cap or timeout and records gaps instead.
import type { Octokit } from '@octokit/rest';
import {
  isAuthoredByCandidate,
  type CandidateIdentity,
  type CollectedContributions,
  type CommitDetail,
  type CommitFile,
  type CommitSummary,
  type Gap,
  type GitIdentity,
  type LinkedAccount,
  type PrLookup,
} from './attribution.js';
import { IngestError, toIngestError } from './ingest.js';

export interface CollectLimits {
  /** Every Octokit call counts, required or optional. */
  maxRequests: number;
  timeoutMs: number;
  maxCommits: number;
  maxDetailedCommits: number;
}

export const DEFAULT_COLLECT_LIMITS: CollectLimits = {
  maxRequests: 150,
  timeoutMs: 60_000,
  maxCommits: 300,
  maxDetailedCommits: 40,
};

const PAGE = 100;
const MAX_FILE_PAGES = 3;
const MAX_PR_COMMIT_PAGES = 3;
// GitHub lists at most 250 commits for a pull request, so a list that long may be cut off.
const PR_COMMIT_LIMIT = 250;

const LIMIT_MINIMUMS: Record<keyof CollectLimits, number> = {
  maxRequests: 2,
  timeoutMs: 1,
  maxCommits: 1,
  maxDetailedCommits: 0,
};

function account(value: unknown): LinkedAccount | null {
  const v = value as { id?: unknown; login?: unknown; type?: unknown } | null;
  if (!v || typeof v.id !== 'number') return null;
  return {
    id: v.id,
    login: typeof v.login === 'string' ? v.login : '',
    type: typeof v.type === 'string' ? v.type : 'User',
  };
}

function gitIdentity(value: unknown): GitIdentity | null {
  const v = value as { name?: unknown; email?: unknown } | null;
  if (!v) return null;
  return {
    name: typeof v.name === 'string' ? v.name : null,
    email: typeof v.email === 'string' ? v.email : null,
  };
}

interface ApiCommit {
  sha: string;
  parents: { sha: string }[];
  commit: { message: string; author: unknown; committer: unknown };
  author: unknown;
  committer: unknown;
}

function toSummary(item: ApiCommit): CommitSummary {
  return {
    sha: item.sha,
    parents: item.parents.map((p) => p.sha),
    message: item.commit.message,
    author: gitIdentity(item.commit.author),
    authorAccount: account(item.author),
    committer: gitIdentity(item.commit.committer),
    committerAccount: account(item.committer),
  };
}

interface ApiFile {
  filename: string;
  status: string;
  sha?: string | null;
  changes: number;
  patch?: string;
}

function toFile(f: ApiFile): CommitFile {
  return {
    path: f.filename,
    status: f.status,
    sha: f.sha ?? null,
    changes: f.changes,
    ...(f.patch !== undefined && { patch: f.patch }),
  };
}

/** Commits, patches and PR landing checks for `candidate` in history reachable from `commitSha`. */
export async function collectContributions(
  octokit: Octokit,
  target: { owner: string; repo: string; commitSha: string },
  candidate: CandidateIdentity,
  limits: CollectLimits = DEFAULT_COLLECT_LIMITS,
): Promise<CollectedContributions> {
  for (const [key, min] of Object.entries(LIMIT_MINIMUMS) as [keyof CollectLimits, number][]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < min) {
      throw new RangeError(`Invalid collection limit: ${key}`);
    }
  }

  const { owner, repo, commitSha } = target;
  const signal = AbortSignal.timeout(limits.timeoutMs);
  const request = { signal };
  const gaps: Gap[] = [];
  let used = 0;
  const hasBudget = () => used < limits.maxRequests;

  async function required<T>(step: string, fn: () => Promise<T>): Promise<T> {
    if (signal.aborted) throw new IngestError('timeout', `Timed out before ${step}`);
    used++;
    try {
      return await fn();
    } catch (err) {
      throw toIngestError(err, step, signal);
    }
  }

  // Optional calls never throw: a failure, the request cap or the timeout all return null.
  async function optional<T>(fn: () => Promise<T>): Promise<T | null> {
    if (signal.aborted || !hasBudget()) return null;
    used++;
    try {
      return await fn();
    } catch {
      return null;
    }
  }

  const { data: repoData } = await required('getRepo', () =>
    octokit.rest.repos.get({ owner, repo, request }),
  );

  const commits: CommitSummary[] = [];
  let more = true;
  for (let page = 1; more && commits.length < limits.maxCommits && hasBudget(); page++) {
    const { data } = await required('listCommits', () =>
      octokit.rest.repos.listCommits({ owner, repo, sha: commitSha, per_page: PAGE, page, request }),
    );
    commits.push(...data.map(toSummary));
    more = data.length === PAGE;
  }
  if (more || commits.length > limits.maxCommits) gaps.push({ reason: 'history_capped' });
  commits.splice(limits.maxCommits);

  async function fetchDetail(sha: string): Promise<CommitDetail> {
    const files: CommitFile[] = [];
    for (let page = 1; page <= MAX_FILE_PAGES; page++) {
      if (!hasBudget()) break;
      let pageFiles: ApiFile[];
      try {
        const { data } = await required('getCommit', () =>
          octokit.rest.repos.getCommit({ owner, repo, ref: sha, per_page: PAGE, page, request }),
        );
        pageFiles = data.files ?? [];
      } catch (err) {
        // GitHub documents 5xx responses for large diffs; that one commit stays partial.
        if (err instanceof IngestError && err.code === 'upstream_error' && (err.status ?? 0) >= 500) {
          gaps.push({ reason: 'commit_detail_failed', commitSha: sha });
          return { files, outcome: 'failed' };
        }
        throw err;
      }
      files.push(...pageFiles.map(toFile));
      if (pageFiles.length < PAGE) return { files, outcome: 'complete' };
    }
    gaps.push({ reason: 'commit_files_capped', commitSha: sha });
    return { files, outcome: 'files_capped' };
  }

  // Committer-only and merge commits never justify fetching code.
  const details = new Map<string, CommitDetail>();
  const authored = commits.filter((c) => c.parents.length <= 1 && isAuthoredByCandidate(c, candidate));
  for (const [i, commit] of authored.entries()) {
    if (i >= limits.maxDetailedCommits || !hasBudget()) {
      gaps.push({ reason: 'commit_details_capped', commitSha: commit.sha });
      continue;
    }
    details.set(commit.sha, await fetchDetail(commit.sha));
  }

  async function lookupPr(sha: string): Promise<PrLookup> {
    const prs = await optional(() =>
      octokit.rest.repos.listPullRequestsAssociatedWithCommit({
        owner,
        repo,
        commit_sha: sha,
        per_page: PAGE,
        request,
      }),
    );
    if (!prs || prs.data.length >= PAGE) return { landing: 'unknown' };

    // Off the default branch this endpoint can also return open PRs, whose merge_commit_sha
    // describes a test merge rather than a landed change.
    const merged = prs.data.filter((pr) => pr.merged_at != null);
    const match = merged.find((pr) => pr.merge_commit_sha === sha);
    const prNumber = (match ?? merged[0])?.number;
    const withPr = prNumber === undefined ? {} : { prNumber };
    if (!match) return { landing: 'not_landing', ...withPr };

    // Fetch the PR's commits first; only a complete list can show the commit is absent from it.
    const prCommits: CommitSummary[] = [];
    for (let page = 1; page <= MAX_PR_COMMIT_PAGES; page++) {
      const res = await optional(() =>
        octokit.rest.pulls.listCommits({
          owner,
          repo,
          pull_number: match.number,
          per_page: PAGE,
          page,
          request,
        }),
      );
      if (!res) return { landing: 'unknown', ...withPr };
      prCommits.push(...res.data.map(toSummary));
      if (res.data.length < PAGE) break;
    }
    if (prCommits.length === 0 || prCommits.length >= PR_COMMIT_LIMIT) {
      return { landing: 'unknown', ...withPr };
    }
    if (prCommits.some((c) => c.sha === sha)) return { landing: 'not_landing', ...withPr };
    return { landing: 'landing', prNumber: match.number, prCommits };
  }

  const prLookups = new Map<string, PrLookup>();
  for (const sha of details.keys()) {
    const lookup = await lookupPr(sha);
    if (lookup.landing === 'unknown') gaps.push({ reason: 'pr_lookup_incomplete', commitSha: sha });
    prLookups.set(sha, lookup);
  }

  return {
    repository: { owner, repo, commitSha, fork: repoData.fork, ownerId: repoData.owner.id },
    commits,
    details,
    prLookups,
    gaps,
    requestsUsed: used,
  };
}
