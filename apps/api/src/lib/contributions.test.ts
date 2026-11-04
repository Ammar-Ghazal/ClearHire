import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';
import type { CandidateIdentity } from './attribution.js';
import {
  BLAME_BATCH,
  collectContributions,
  DEFAULT_COLLECT_LIMITS,
  pinHistory,
  type CollectLimits,
} from './contributions.js';
import { IngestError } from './ingest.js';

const TOKEN = 'ghu_secret_token';
const target = { owner: 'octo', repo: 'demo', commitSha: 'head' };
const CANDIDATE: CandidateIdentity = { githubUserId: 101, login: 'cand', verifiedEmails: [] };
const ME = { databaseId: 101, login: 'cand' };
const OTHER = { databaseId: 202, login: 'other' };

function httpError(status: number, headers: Record<string, string> = {}) {
  return Object.assign(new Error(`HttpError ${TOKEN}`), { status, response: { headers } });
}

interface FakeCommit {
  sha: string;
  author?: typeof ME | null;
  parents?: number;
  /** Associated PRs as GitHub lists them for this commit. */
  prs?: { number: number; merged: boolean; mergeCommit: { oid: string } | null }[];
  /** More associated PRs than listed: the list is cut off. */
  prTotal?: number;
}

function apiCommit({ sha, author = ME, parents = 1 }: FakeCommit) {
  return {
    oid: sha,
    message: 'Change',
    parents: { nodes: Array.from({ length: parents }, (_, i) => ({ oid: `${sha}-p${i}` })) },
    author: { name: 'A', email: 'a@example.com', user: author },
    committer: { name: 'C', email: 'c@example.com', user: OTHER },
  };
}

type Vars = Record<string, unknown>;

/**
 * A fake `octokit.graphql`: history pages of 100 by cursor, PR commit lists from `prCommits`, and
 * blame from `blame` (path → commit owning every line). `fail` lets a test break single queries.
 */
function fakeOctokit(
  commits: FakeCommit[],
  opts: {
    blame?: Record<string, string>;
    prCommits?: Record<number, FakeCommit[]>;
    fail?: (kind: 'history' | 'pr' | 'blame', vars: Vars) => unknown;
    /** The default branch has no commit (an empty repository). */
    empty?: boolean;
  } = {},
) {
  const calls: { kind: 'history' | 'pr' | 'blame'; vars: Vars }[] = [];
  const graphql = vi.fn(async (document: string, vars: Vars) => {
    const kind = document.includes('history(') ? 'history' : document.includes('blame(') ? 'blame' : 'pr';
    calls.push({ kind, vars });
    const failure = opts.fail?.(kind, vars);
    if (failure) throw failure;
    if (kind === 'history') {
      const start = vars.after ? Number(vars.after) : 0;
      const nodes = commits.slice(start, start + 100).map((c) => ({
        ...apiCommit(c),
        associatedPullRequests: { totalCount: c.prTotal ?? (c.prs ?? []).length, nodes: c.prs ?? [] },
      }));
      const end = start + nodes.length;
      // The pinned commit: the given oid, or the default branch head.
      const head = {
        oid: (vars.oid as string | undefined) ?? 'head',
        tree: { oid: 'tree-head' },
        history: { pageInfo: { hasNextPage: end < commits.length, endCursor: String(end) }, nodes },
      };
      const root = document.includes('defaultBranchRef')
        ? { defaultBranchRef: opts.empty ? null : { target: head } }
        : { object: head };
      return { repository: { isFork: false, owner: { databaseId: 999 }, ...root } };
    }
    const keys = Object.keys(vars).filter((k) => /^[pn]\d+$/.test(k));
    if (kind === 'pr') {
      const repository = Object.fromEntries(
        keys.map((k, j) => {
          const list = opts.prCommits?.[vars[k] as number];
          return [
            `p${j}`,
            list && {
              commits: { totalCount: list.length, nodes: list.map((c) => ({ commit: apiCommit(c) })) },
            },
          ];
        }),
      );
      return { repository };
    }
    const object = Object.fromEntries(
      keys.map((k, j) => {
        const owner = opts.blame?.[vars[k] as string];
        const ranges = owner ? [{ startingLine: 1, endingLine: 3, commit: { oid: owner } }] : [];
        return [`f${j}`, { ranges }];
      }),
    );
    return { repository: { object } };
  });
  return { octokit: { graphql } as unknown as Octokit, graphql, calls };
}

const run = (octokit: Octokit, paths: string[] = [], limits: Partial<CollectLimits> = {}) =>
  collectContributions(octokit, target, CANDIDATE, paths, { ...DEFAULT_COLLECT_LIMITS, ...limits });

async function ingestError(promise: Promise<unknown>): Promise<IngestError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(IngestError);
  expect((err as Error).message).not.toContain(TOKEN);
  return err as IngestError;
}

describe('collectContributions', () => {
  it('blames kept files at the pinned commit, keeping only the candidate commits', async () => {
    const { octokit, calls } = fakeOctokit(
      [{ sha: 'mine' }, { sha: 'theirs', author: OTHER }, { sha: 'merge', parents: 2 }],
      { blame: { 'src/a.ts': 'mine', 'src/b.ts': 'theirs', 'src/c.ts': 'merge' } },
    );
    const out = await run(octokit, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(calls.map((c) => c.kind)).toEqual(['history', 'blame']);
    expect(calls[0]!.vars).toMatchObject({ oid: 'head', after: null });
    expect(calls[1]!.vars).toMatchObject({ oid: 'head', p0: 'src/a.ts' });
    expect([...out.blame]).toEqual([['mine', [{ path: 'src/a.ts', start: 1, end: 3 }]]]);
    expect(out.repository).toEqual({ ...target, fork: false, ownerId: 999 });
    expect(out.gaps).toEqual([]);
  });

  it('skips blame when the candidate authored nothing', async () => {
    const { octokit, calls } = fakeOctokit([{ sha: 'theirs', author: OTHER }]);
    const out = await run(octokit, ['src/a.ts']);
    expect(calls.map((c) => c.kind)).toEqual(['history']);
    expect(out.blame.size).toBe(0);
  });

  it('pages history by cursor and records a capped history', async () => {
    const commits = Array.from({ length: 250 }, (_, i) => ({ sha: `c${i}`, author: OTHER }));
    const { octokit, calls } = fakeOctokit(commits);
    const out = await run(octokit, [], { maxCommits: 150 });
    expect(calls.map((c) => c.vars.after)).toEqual([null, '100']);
    expect(out.commits).toHaveLength(150);
    expect(out.gaps).toEqual([{ reason: 'history_capped' }]);
  });

  it('decides a landing from the merged PR and its complete commit list', async () => {
    const landed = { number: 1, merged: true, mergeCommit: { oid: 'squash' } };
    const { octokit } = fakeOctokit(
      [
        { sha: 'squash', prs: [landed] },
        { sha: 'rebased', prs: [{ number: 2, merged: true, mergeCommit: { oid: 'rebased' } }] },
        { sha: 'testmerge', prs: [{ number: 3, merged: false, mergeCommit: { oid: 'testmerge' } }] },
        { sha: 'direct' },
      ],
      { prCommits: { 1: [{ sha: 'a', author: OTHER }], 2: [{ sha: 'rebased' }] } },
    );
    const out = await run(octokit);
    expect(out.prLookups.get('squash')).toMatchObject({ landing: 'landing', prNumber: 1 });
    expect(out.prLookups.get('squash')!.prCommits!.map((c) => c.sha)).toEqual(['a']);
    // The commit itself is in its PR, so the PR's other commits say nothing about it.
    expect(out.prLookups.get('rebased')).toEqual({ landing: 'not_landing', prNumber: 2 });
    // An open PR's merge commit is a test merge, never a landing.
    expect(out.prLookups.get('testmerge')).toEqual({ landing: 'not_landing' });
    expect(out.prLookups.get('direct')).toEqual({ landing: 'not_landing' });
    expect(out.gaps).toEqual([]);
  });

  it('leaves landings unknown when the PR list or its commits are cut off or fail', async () => {
    const { octokit } = fakeOctokit(
      [
        { sha: 'crowded', prs: [{ number: 9, merged: true, mergeCommit: null }], prTotal: 11 },
        { sha: 'missing', prs: [{ number: 50, merged: true, mergeCommit: { oid: 'missing' } }] },
      ],
      { fail: (kind) => kind === 'pr' && httpError(502) },
    );
    const out = await run(octokit);
    expect(out.prLookups.get('crowded')).toEqual({ landing: 'unknown' });
    expect(out.prLookups.get('missing')).toEqual({ landing: 'unknown', prNumber: 50 });
    expect(out.gaps).toContainEqual({ reason: 'pr_lookup_incomplete', commitSha: 'missing' });
  });

  it('splits a failing blame query so only the file that fails is left out', async () => {
    const paths = Array.from({ length: 4 }, (_, i) => `src/f${i}.ts`);
    const { octokit, calls } = fakeOctokit([{ sha: 'mine' }], {
      blame: Object.fromEntries(paths.map((p) => [p, 'mine'])),
      fail: (kind, vars) => kind === 'blame' && Object.values(vars).includes('src/f2.ts') && httpError(502),
    });
    const out = await run(octokit, paths);
    expect(calls.filter((c) => c.kind === 'blame')).toHaveLength(5);
    expect(out.blame.get('mine')!.map((r) => r.path)).toEqual(['src/f0.ts', 'src/f1.ts', 'src/f3.ts']);
    expect(out.gaps).toEqual([{ reason: 'blame_incomplete', path: 'src/f2.ts' }]);
  });

  it('treats an empty 200 body like a failed query: the batch splits and only that file is left out', async () => {
    const paths = ['src/big.ts', 'src/ok.ts'];
    const { octokit, graphql } = fakeOctokit([{ sha: 'mine' }], { blame: { 'src/ok.ts': 'mine' } });
    const real = graphql.getMockImplementation()!;
    // GitHub answers a blame that overran its limit with an empty body, which Octokit returns as-is.
    graphql.mockImplementation(async (document: string, vars: Vars) =>
      document.includes('blame(') && Object.values(vars).includes('src/big.ts')
        ? (undefined as never)
        : real(document, vars),
    );
    const out = await run(octokit, paths);
    expect(out.blame.get('mine')!.map((r) => r.path)).toEqual(['src/ok.ts']);
    expect(out.gaps).toEqual([{ reason: 'blame_incomplete', path: 'src/big.ts' }]);
  });

  it('records files a partial response leaves null, and files past the request cap', async () => {
    const paths = Array.from({ length: BLAME_BATCH + 1 }, (_, i) => `src/f${i}.ts`);
    const partial = Object.assign(new Error('partial'), {
      name: 'GraphqlResponseError',
      errors: [{ type: 'NOT_FOUND' }],
      data: { repository: { object: { f0: null, f1: { ranges: [] } } } },
    });
    const { octokit } = fakeOctokit([{ sha: 'mine' }], {
      fail: (kind, vars) => kind === 'blame' && vars.p1 !== undefined && partial,
    });
    const out = await run(octokit, paths, { maxRequests: 2 });
    expect(out.gaps.filter((g) => g.path === 'src/f0.ts')).toHaveLength(1);
    // The second blame query does not fit the cap: its one file is recorded, not dropped.
    expect(out.gaps).toContainEqual({ reason: 'blame_incomplete', path: `src/f${BLAME_BATCH}.ts` });
    expect(out.requestsUsed).toBe(2);
  });

  it('defers on a GraphQL or HTTP quota response instead of recording a gap', async () => {
    const limited = Object.assign(new Error('limited'), {
      name: 'GraphqlResponseError',
      errors: [{ type: 'RATE_LIMITED' }],
      headers: { 'x-ratelimit-reset': '2000000000' },
    });
    const graphqlQuota = fakeOctokit([{ sha: 'mine' }], { fail: (k) => k === 'blame' && limited });
    const err = await ingestError(run(graphqlQuota.octokit, ['src/a.ts']));
    expect(err).toMatchObject({ code: 'rate_limited', resetAt: 2_000_000_000_000 });

    const headers = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000000000' };
    const httpQuota = fakeOctokit([], { fail: () => httpError(403, headers) });
    expect((await ingestError(run(httpQuota.octokit))).code).toBe('rate_limited');
  });

  it('fails the run when the required history query fails', async () => {
    const { octokit } = fakeOctokit([], { fail: (k) => k === 'history' && httpError(502) });
    expect((await ingestError(run(octokit))).code).toBe('upstream_error');
  });

  it('pins the default branch head and its tree in the first history query', async () => {
    const { octokit, calls } = fakeOctokit([{ sha: 'mine' }], { blame: { 'src/a.ts': 'mine' } });
    const pinned = await pinHistory(octokit, { owner: 'octo', repo: 'demo' });
    expect(pinned).toMatchObject({ commitSha: 'head', treeSha: 'tree-head' });
    expect(calls[0]!.vars).toEqual(expect.not.objectContaining({ oid: expect.anything() }));
    // Collection reuses that page: only blame is queried afterwards.
    const out = await collectContributions(octokit, target, CANDIDATE, ['src/a.ts'],
      DEFAULT_COLLECT_LIMITS, pinned);
    expect(calls.map((c) => c.kind)).toEqual(['history', 'blame']);
    expect(out.commits.map((c) => c.sha)).toEqual(['mine']);
    expect(out.requestsUsed).toBe(2);
  });

  it('pins a resumed commit by SHA, and refuses an empty repository', async () => {
    const { octokit, calls } = fakeOctokit([]);
    expect(await pinHistory(octokit, { owner: 'octo', repo: 'demo', ref: 'abc' })).toMatchObject({
      commitSha: 'abc',
    });
    expect(calls[0]!.vars).toMatchObject({ oid: 'abc' });
    const empty = fakeOctokit([], { empty: true });
    const err = await ingestError(pinHistory(empty.octokit, { owner: 'octo', repo: 'demo' }));
    expect(err.code).toBe('empty_repository');
  });

  it('rejects invalid limits by name', async () => {
    const { octokit } = fakeOctokit([]);
    await expect(run(octokit, [], { maxRequests: 0 })).rejects.toThrow('maxRequests');
  });
});
