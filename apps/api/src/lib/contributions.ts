// Bounded GitHub GraphQL collection of commit evidence for one candidate at a pinned commit: history
// with linked accounts and pull requests, PR commit lists for landings, then `git blame` of the kept
// files. GraphQL has its own quota, so none of this spends the REST quota downloads use.
// https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api
import type { Octokit } from '@octokit/rest';
import {
  isAuthoredByCandidate,
  type BlameRange,
  type CandidateIdentity,
  type CollectedContributions,
  type CommitSummary,
  type Gap,
  type PrLookup,
} from './attribution.js';
import { IngestError, toIngestError } from './ingest.js';

export interface CollectLimits {
  /** Every GraphQL query counts, required or optional. */
  maxRequests: number;
  /** For the history and PR lookups; blame adds `BLAME_MS_PER_FILE` per blamed file. */
  timeoutMs: number;
  maxCommits: number;
}

export const DEFAULT_COLLECT_LIMITS: CollectLimits = {
  maxRequests: 150,
  timeoutMs: 60_000,
  maxCommits: 300,
};

const PAGE = 100;
/** Files blamed per query; a failed query is split until single files fail on their own. */
export const BLAME_BATCH = 25;
const BLAME_MS_PER_FILE = 500;
/** PR commit lists fetched per query. */
const PR_BATCH = 20;
// A commit is introduced by one merged PR; more listed PRs than this means the list is cut off.
const PRS_PER_COMMIT = 10;

const LIMIT_MINIMUMS: Record<keyof CollectLimits, number> = {
  maxRequests: 1,
  timeoutMs: 1,
  maxCommits: 1,
};

interface ApiActor {
  name: string | null;
  email: string | null;
  user: { databaseId: number | null; login: string } | null;
}

interface ApiCommit {
  oid: string;
  message: string;
  parents: { nodes: { oid: string }[] };
  author: ApiActor | null;
  committer: ApiActor | null;
}

interface ApiHistoryCommit extends ApiCommit {
  associatedPullRequests: {
    totalCount: number;
    nodes: { number: number; merged: boolean; mergeCommit: { oid: string } | null }[];
  } | null;
}

const COMMIT_FIELDS = `fragment C on Commit {
  oid message
  parents(first: 2) { nodes { oid } }
  author { name email user { databaseId login } }
  committer { name email user { databaseId login } }
}`;

/** History from the default branch head (pinning it), or from a commit already pinned. */
const historyQuery = (root: 'default' | 'oid') => `query($owner: String!, $name: String!${
  root === 'oid' ? ', $oid: GitObjectID!' : ''
}, $after: String) {
  repository(owner: $owner, name: $name) {
    isFork
    owner { ... on User { databaseId } ... on Organization { databaseId } }
    ${root === 'oid' ? 'object(oid: $oid) { ...H }' : 'defaultBranchRef { target { ...H } }'}
  }
}
fragment H on Commit {
  oid tree { oid }
  history(first: ${PAGE}, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ...C associatedPullRequests(first: ${PRS_PER_COMMIT}) {
      totalCount nodes { number merged mergeCommit { oid } }
    } }
  }
}
${COMMIT_FIELDS}`;

interface HistoryPage {
  fork: boolean;
  ownerId: number;
  commitSha: string;
  treeSha: string;
  hasNextPage: boolean;
  endCursor: string | null;
  nodes: ApiHistoryCommit[];
}

/** A commit pinned by the first history query, with that page so collection need not repeat it. */
export interface PinnedHistory {
  commitSha: string;
  treeSha: string;
  page: HistoryPage;
}

/** One GraphQL query. A partial response returns its data (failed fields are null); quota throws. */
async function graphqlQuery<T>(
  octokit: Octokit,
  step: string,
  document: string,
  variables: object,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw new IngestError('timeout', `Timed out before ${step}`);
  let result: T | undefined;
  try {
    result = await octokit.graphql<T>(document, { ...variables, request: { signal } });
  } catch (err) {
    const e = err as {
      name?: string;
      errors?: { type?: string }[];
      data?: T;
      headers?: Record<string, string | undefined>;
    };
    if (e.name === 'GraphqlResponseError') {
      if (e.errors?.some((x) => x.type === 'RATE_LIMITED')) {
        const reset = Number(e.headers?.['x-ratelimit-reset']);
        const at = Number.isFinite(reset) ? reset * 1000 : Date.now() + 60_000;
        throw new IngestError('rate_limited', `GitHub GraphQL quota hit during ${step}`, 403, at);
      }
      if (e.data) return e.data;
    }
    throw toIngestError(err, step, signal);
  }
  // GitHub can answer a query that overran its time limit with an empty 200 body.
  if (result === null || typeof result !== 'object') {
    throw new IngestError('upstream_error', `GitHub returned no data during ${step}`, 200);
  }
  return result;
}

async function historyPage(
  octokit: Octokit,
  target: { owner: string; repo: string; oid?: string },
  after: string | null,
  signal: AbortSignal,
): Promise<HistoryPage> {
  type Commit = {
    oid: string;
    tree: { oid: string };
    history: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: ApiHistoryCommit[];
    };
  };
  type History = {
    repository: {
      isFork: boolean;
      owner: { databaseId?: number };
      object?: Commit | null;
      defaultBranchRef?: { target: Commit | null } | null;
    } | null;
  };
  const { owner, repo, oid } = target;
  const data = await graphqlQuery<History>(
    octokit,
    'history',
    historyQuery(oid ? 'oid' : 'default'),
    { owner, name: repo, after, ...(oid && { oid }) },
    signal,
  );
  if (!data.repository) throw new IngestError('not_found', 'GitHub returned no repository');
  if (!oid && !data.repository.defaultBranchRef) {
    throw new IngestError('empty_repository', 'Repository has no default branch commit');
  }
  const commit = oid ? data.repository.object : data.repository.defaultBranchRef?.target;
  if (!commit?.history) throw new IngestError('not_found', 'GitHub returned no history for the commit');
  return {
    fork: data.repository.isFork,
    ownerId: data.repository.owner.databaseId ?? 0,
    commitSha: commit.oid,
    treeSha: commit.tree.oid,
    hasNextPage: commit.history.pageInfo.hasNextPage,
    endCursor: commit.history.pageInfo.endCursor,
    nodes: commit.history.nodes,
  };
}

/**
 * Pins `ref` (a commit SHA) or, when omitted, the default branch head, in the same GraphQL query
 * that returns the first page of its history: no REST request is needed to pin a commit.
 */
export async function pinHistory(
  octokit: Octokit,
  target: { owner: string; repo: string; ref?: string },
  signal: AbortSignal = AbortSignal.timeout(DEFAULT_COLLECT_LIMITS.timeoutMs),
): Promise<PinnedHistory> {
  const { owner, repo, ref } = target;
  const page = await historyPage(octokit, { owner, repo, ...(ref && { oid: ref }) }, null, signal);
  return { commitSha: page.commitSha, treeSha: page.treeSha, page };
}

// GraphQL users only: a bot has no user, so it resolves by its [bot] noreply email instead.
const account = (a: ApiActor | null) =>
  a?.user?.databaseId ? { id: a.user.databaseId, login: a.user.login, type: 'User' } : null;
const git = (a: ApiActor | null) => (a ? { name: a.name, email: a.email } : null);

function toSummary(c: ApiCommit): CommitSummary {
  return {
    sha: c.oid,
    parents: c.parents.nodes.map((p) => p.oid),
    message: c.message,
    author: git(c.author),
    authorAccount: account(c.author),
    committer: git(c.committer),
    committerAccount: account(c.committer),
  };
}

/** Commits, PR landing checks and blame for `candidate` in history reachable from `commitSha`. */
export async function collectContributions(
  octokit: Octokit,
  target: { owner: string; repo: string; commitSha: string },
  candidate: CandidateIdentity,
  /** Kept files of the snapshot: only these are blamed. */
  paths: readonly string[],
  limits: CollectLimits = DEFAULT_COLLECT_LIMITS,
  /** The pinning query's first page, reused when it pinned `commitSha`. */
  pinned?: PinnedHistory,
): Promise<CollectedContributions> {
  for (const [key, min] of Object.entries(LIMIT_MINIMUMS) as [keyof CollectLimits, number][]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < min) {
      throw new RangeError(`Invalid collection limit: ${key}`);
    }
  }

  const { owner, repo, commitSha } = target;
  const signal = AbortSignal.timeout(limits.timeoutMs + paths.length * BLAME_MS_PER_FILE);
  const base = { owner, name: repo };
  const gaps: Gap[] = [];
  let used = 0;
  const hasBudget = () => used < limits.maxRequests && !signal.aborted;

  const query = <T>(step: string, document: string, variables: object): Promise<T> => {
    used++;
    return graphqlQuery<T>(octokit, step, document, variables, signal);
  };

  // ---- History (required) ----
  const commits: CommitSummary[] = [];
  const prsOf = new Map<string, NonNullable<ApiHistoryCommit['associatedPullRequests']>>();
  let repository: CollectedContributions['repository'] | null = null;
  let after: string | null = null;
  let more = true;
  let first = pinned?.commitSha === commitSha ? pinned.page : undefined;
  if (first) used++;
  // Required: a timeout throws instead of looking like a short history.
  while (more && commits.length < limits.maxCommits && (first || used < limits.maxRequests)) {
    let page: HistoryPage;
    if (first) {
      page = first;
      first = undefined;
    } else {
      used++;
      page = await historyPage(octokit, { owner, repo, oid: commitSha }, after, signal);
    }
    repository ??= { owner, repo, commitSha, fork: page.fork, ownerId: page.ownerId };
    for (const node of page.nodes) {
      commits.push(toSummary(node));
      if (node.associatedPullRequests) prsOf.set(node.oid, node.associatedPullRequests);
    }
    more = page.hasNextPage;
    after = page.endCursor;
  }
  if (!repository) throw new IngestError('timeout', 'No history query fit the request cap');
  if (more || commits.length > limits.maxCommits) gaps.push({ reason: 'history_capped' });
  commits.splice(limits.maxCommits);

  // Committer-only and merge commits never count as the candidate's code.
  const authored = commits.filter((c) => c.parents.length <= 1 && isAuthoredByCandidate(c, candidate));

  // ---- PR landings (optional) ----
  const prLookups = new Map<string, PrLookup>();
  const landings: { sha: string; number: number }[] = [];
  for (const c of authored) {
    const prs = prsOf.get(c.sha);
    if (!prs || prs.totalCount > prs.nodes.length) {
      prLookups.set(c.sha, { landing: 'unknown' });
      continue;
    }
    // Off the default branch this can also list open PRs, whose merge commit is a test merge.
    const merged = prs.nodes.filter((pr) => pr.merged);
    const match = merged.find((pr) => pr.mergeCommit?.oid === c.sha);
    const prNumber = (match ?? merged[0])?.number;
    const withPr = prNumber === undefined ? {} : { prNumber };
    if (match) landings.push({ sha: c.sha, number: match.number });
    else prLookups.set(c.sha, { landing: 'not_landing', ...withPr });
  }
  const prNumbers = [...new Set(landings.map((l) => l.number))];
  const prCommits = new Map<number, CommitSummary[] | null>();
  for (let i = 0; i < prNumbers.length; i += PR_BATCH) {
    const batch = prNumbers.slice(i, i + PR_BATCH);
    if (!hasBudget()) break;
    const fields = batch
      .map((_, j) => `p${j}: pullRequest(number: $n${j}) {
        commits(first: ${PAGE}) { totalCount nodes { commit { ...C } } } }`)
      .join('\n');
    const vars = batch.map((_, j) => `$n${j}: Int!`).join(', ');
    type Prs = {
      repository: Record<
        string,
        { commits: { totalCount: number; nodes: { commit: ApiCommit }[] } } | null
      > | null;
    };
    let data: Prs | null = null;
    try {
      data = await query<Prs>(
        'pullRequestCommits',
        `query($owner: String!, $name: String!, ${vars}) {
          repository(owner: $owner, name: $name) { ${fields} } }\n${COMMIT_FIELDS}`,
        { ...base, ...Object.fromEntries(batch.map((n, j) => [`n${j}`, n])) },
      );
    } catch (err) {
      if (err instanceof IngestError && err.code === 'rate_limited') throw err;
    }
    batch.forEach((n, j) => {
      const list = data?.repository?.[`p${j}`]?.commits;
      // shortcut: one page of PR commits; a PR with more is left unknown, upgrade if that is common.
      const complete = list && list.totalCount > 0 && list.totalCount <= list.nodes.length;
      prCommits.set(n, complete ? list.nodes.map((x) => toSummary(x.commit)) : null);
    });
  }
  for (const { sha, number } of landings) {
    const list = prCommits.get(number);
    if (!list) prLookups.set(sha, { landing: 'unknown', prNumber: number });
    else if (list.some((c) => c.sha === sha)) {
      prLookups.set(sha, { landing: 'not_landing', prNumber: number });
    } else prLookups.set(sha, { landing: 'landing', prNumber: number, prCommits: list });
  }
  for (const c of authored) {
    if (prLookups.get(c.sha)?.landing === 'unknown') {
      gaps.push({ reason: 'pr_lookup_incomplete', commitSha: c.sha });
    }
  }

  // ---- Blame (only when the candidate authored something) ----
  const blame = new Map<string, BlameRange[]>();
  const mine = new Set(authored.map((c) => c.sha));
  const pending: string[][] = [];
  if (mine.size > 0) {
    for (let i = 0; i < paths.length; i += BLAME_BATCH) pending.push(paths.slice(i, i + BLAME_BATCH));
  }
  while (pending.length > 0) {
    const batch = pending.shift()!;
    if (!hasBudget()) {
      for (const path of [batch, ...pending].flat()) gaps.push({ reason: 'blame_incomplete', path });
      break;
    }
    type Blame = {
      repository: {
        object: Record<
          string,
          { ranges: { startingLine: number; endingLine: number; commit: { oid: string } }[] } | null
        > | null;
      } | null;
    };
    let data: Blame;
    try {
      data = await query<Blame>(
        'blame',
        `query($owner: String!, $name: String!, $oid: GitObjectID!, ${batch
          .map((_, j) => `$p${j}: String!`)
          .join(', ')}) {
          repository(owner: $owner, name: $name) { object(oid: $oid) { ... on Commit {
            ${batch
              .map((_, j) => `f${j}: blame(path: $p${j}) { ranges {
                startingLine endingLine commit { oid } } }`)
              .join('\n')}
          } } } }`,
        { ...base, oid: commitSha, ...Object.fromEntries(batch.map((p, j) => [`p${j}`, p])) },
      );
    } catch (err) {
      if (err instanceof IngestError && err.code === 'rate_limited') throw err;
      // A large file can time a whole query out: retry halves, so only that file is left out.
      if (batch.length > 1 && !signal.aborted) {
        const half = Math.ceil(batch.length / 2);
        pending.unshift(batch.slice(0, half), batch.slice(half));
      } else {
        for (const path of batch) gaps.push({ reason: 'blame_incomplete', path });
      }
      continue;
    }
    batch.forEach((path, j) => {
      const file = data.repository?.object?.[`f${j}`];
      if (!file) {
        gaps.push({ reason: 'blame_incomplete', path });
        return;
      }
      for (const r of file.ranges) {
        if (!mine.has(r.commit.oid)) continue;
        const list = blame.get(r.commit.oid) ?? [];
        list.push({ path, start: r.startingLine, end: r.endingLine });
        blame.set(r.commit.oid, list);
      }
    });
  }

  return { repository, commits, blame, prLookups, gaps, requestsUsed: used };
}
