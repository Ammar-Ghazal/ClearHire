import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';
import type { CandidateIdentity } from './attribution.js';
import { collectContributions, DEFAULT_COLLECT_LIMITS, type CollectLimits } from './contributions.js';
import { IngestError } from './ingest.js';

const TOKEN = 'ghu_secret_token';
const target = { owner: 'octo', repo: 'demo', commitSha: 'head' };
const CANDIDATE: CandidateIdentity = { githubUserId: 101, login: 'cand', verifiedEmails: [] };
const ME = { id: 101, login: 'cand', type: 'User' };
const OTHER = { id: 202, login: 'other', type: 'User' };

function httpError(status: number, headers: Record<string, string> = {}) {
  return Object.assign(new Error(`HttpError ${TOKEN}`), { status, response: { headers } });
}

interface FakeCommit {
  sha: string;
  author?: typeof ME | null;
  committer?: typeof ME | null;
  parents?: number;
}

function apiCommit({ sha, author = ME, committer = OTHER, parents = 1 }: FakeCommit) {
  return {
    sha,
    parents: Array.from({ length: parents }, (_, i) => ({ sha: `${sha}-p${i}` })),
    commit: {
      message: 'Change',
      author: { name: 'A', email: 'a@example.com' },
      committer: { name: 'C', email: 'c@example.com' },
    },
    author,
    committer,
  };
}

const file = (n: number) => ({
  filename: `src/f${n}.ts`,
  status: 'modified',
  sha: `blob-${n}`,
  changes: 1,
  patch: '@@ -1,1 +1,1 @@\n-a\n+b',
});

/** History pages slice `commits`; each getCommit page has `filesPerCommit` files. */
function fakeOctokit(commits: FakeCommit[], opts: { filesPerCommit?: number } = {}) {
  const filesPerCommit = opts.filesPerCommit ?? 1;
  const page = <T>(items: T[], p = 1, per = 100) => items.slice((p - 1) * per, p * per);

  const rest = {
    repos: {
      get: vi.fn(async () => ({ data: { fork: false, owner: { id: 999 } } })),
      listCommits: vi.fn(async ({ page: p }: { page: number }) => ({
        data: page(commits.map(apiCommit), p),
      })),
      getCommit: vi.fn(async ({ page: p }: { ref: string; page: number }) => ({
        data: { files: page(Array.from({ length: filesPerCommit }, (_, i) => file(i)), p) },
      })),
      listPullRequestsAssociatedWithCommit: vi.fn(
        async (_: { commit_sha: string; request?: { signal: AbortSignal } }) => ({
          data: [] as { number: number; merge_commit_sha: string | null; merged_at: string | null }[],
        }),
      ),
    },
    pulls: {
      listCommits: vi.fn(async (_: { pull_number: number; page: number }) => ({
        data: [] as ReturnType<typeof apiCommit>[],
      })),
    },
  };
  return { octokit: { rest } as unknown as Octokit, rest };
}

const run = (octokit: Octokit, limits: Partial<CollectLimits> = {}) =>
  collectContributions(octokit, target, CANDIDATE, { ...DEFAULT_COLLECT_LIMITS, ...limits });

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
  it('fetches patches only for authored non-merge commits', async () => {
    const { octokit, rest } = fakeOctokit([
      { sha: 'mine' },
      { sha: 'committed', author: OTHER, committer: ME },
      { sha: 'merge', parents: 2 },
      { sha: 'root', parents: 0 },
    ]);
    const out = await run(octokit);
    expect(rest.repos.getCommit.mock.calls.map(([a]) => a.ref)).toEqual(['mine', 'root']);
    expect([...out.details.keys()]).toEqual(['mine', 'root']);
    expect(out.commits).toHaveLength(4);
    expect(out.gaps).toEqual([]);
    expect(out.prLookups.get('mine')).toEqual({ landing: 'not_landing' });
  });

  it('records capped history, details and changed files', async () => {
    const commits = Array.from({ length: 250 }, (_, i) => ({ sha: `c${i}` }));
    const { octokit } = fakeOctokit(commits, { filesPerCommit: 300 });
    const out = await run(octokit, { maxCommits: 200, maxDetailedCommits: 2 });
    expect(out.commits).toHaveLength(200);
    expect(out.gaps.filter((g) => g.reason === 'history_capped')).toHaveLength(1);
    expect(out.gaps.filter((g) => g.reason === 'commit_details_capped')).toHaveLength(198);
    expect(out.gaps.filter((g) => g.reason === 'commit_files_capped')).toHaveLength(2);
    expect(out.details.get('c0')).toMatchObject({ outcome: 'files_capped' });
    expect(out.details.get('c0')!.files).toHaveLength(300);
  });

  it('keeps a 5xx detail as a failed commit and continues', async () => {
    const { octokit, rest } = fakeOctokit([{ sha: 'a' }, { sha: 'b' }]);
    rest.repos.getCommit.mockRejectedValueOnce(httpError(502));
    const out = await run(octokit);
    expect(out.details.get('a')).toEqual({ files: [], outcome: 'failed' });
    expect(out.details.get('b')).toMatchObject({ outcome: 'complete' });
    expect(out.gaps).toEqual([{ reason: 'commit_detail_failed', commitSha: 'a' }]);
  });

  it('decides a landing only after fetching the PR commits', async () => {
    const { octokit, rest } = fakeOctokit([{ sha: 'squash' }, { sha: 'kept' }]);
    rest.repos.listPullRequestsAssociatedWithCommit.mockImplementation(async ({ commit_sha }) => ({
      data: [{ number: commit_sha === 'squash' ? 1 : 2, merge_commit_sha: commit_sha, merged_at: '2026-01-01T00:00:00Z' }],
    }));
    rest.pulls.listCommits.mockImplementation(async ({ pull_number }) => ({
      data: pull_number === 1 ? [apiCommit({ sha: 'orig', author: OTHER })] : [apiCommit({ sha: 'kept' })],
    }));
    const out = await run(octokit);
    expect(out.prLookups.get('squash')).toMatchObject({ landing: 'landing', prNumber: 1 });
    expect(out.prLookups.get('squash')!.prCommits!.map((c) => c.sha)).toEqual(['orig']);
    expect(out.prLookups.get('kept')).toEqual({ landing: 'not_landing', prNumber: 2 });
  });

  it('does not treat an open PR test-merge SHA as a landed contribution', async () => {
    const { octokit, rest } = fakeOctokit([{ sha: 'a' }]);
    rest.repos.listPullRequestsAssociatedWithCommit.mockResolvedValue({
      data: [{ number: 7, merge_commit_sha: 'a', merged_at: null }],
    });
    const out = await run(octokit);
    expect(out.prLookups.get('a')).toEqual({ landing: 'not_landing' });
    expect(rest.pulls.listCommits).not.toHaveBeenCalled();
  });

  it.each([
    ['a full associated-PR page', 'full'],
    ['a failed associated-PR lookup', 'lookup'],
    ['a failed PR commit list', 'commits'],
    ['250 PR commits', '250'],
  ])('leaves the landing unknown after %s', async (_, mode) => {
    const { octokit, rest } = fakeOctokit([{ sha: 'a' }]);
    const pr = { number: 1, merge_commit_sha: 'a', merged_at: '2026-01-01T00:00:00Z' };
    rest.repos.listPullRequestsAssociatedWithCommit.mockImplementation(async () => {
      if (mode === 'lookup') throw httpError(500);
      return { data: mode === 'full' ? Array.from({ length: 100 }, () => pr) : [pr] };
    });
    rest.pulls.listCommits.mockImplementation(async ({ page }) => {
      if (mode === 'commits') throw httpError(500);
      const count = Math.min(100, 250 - (page - 1) * 100);
      return { data: Array.from({ length: count }, (_, i) => apiCommit({ sha: `o${page}-${i}` })) };
    });
    const out = await run(octokit);
    expect(out.prLookups.get('a')!.landing).toBe('unknown');
    expect(out.gaps).toContainEqual({ reason: 'pr_lookup_incomplete', commitSha: 'a' });
  });

  it('stays within the request cap and stops enrichment with gaps, not a throw', async () => {
    const commits = Array.from({ length: 300 }, (_, i) => ({ sha: `c${i}` }));
    const { octokit, rest } = fakeOctokit(commits, { filesPerCommit: 250 });
    rest.repos.listPullRequestsAssociatedWithCommit.mockImplementation(async ({ commit_sha }) => ({
      data: [{ number: 1, merge_commit_sha: commit_sha, merged_at: '2026-01-01T00:00:00Z' }],
    }));
    rest.pulls.listCommits.mockResolvedValue({ data: [apiCommit({ sha: 'original' })] });
    const out = await run(octokit, { maxRequests: 20 });
    const calls =
      rest.repos.get.mock.calls.length +
      rest.repos.listCommits.mock.calls.length +
      rest.repos.getCommit.mock.calls.length +
      rest.repos.listPullRequestsAssociatedWithCommit.mock.calls.length +
      rest.pulls.listCommits.mock.calls.length;
    expect(calls).toBe(20);
    expect(out.requestsUsed).toBe(20);
    expect(out.gaps.map((g) => g.reason)).toEqual(
      expect.arrayContaining(['commit_details_capped', 'pr_lookup_incomplete']),
    );
    expect([...out.prLookups.values()].every((l) => l.landing === 'unknown')).toBe(true);
  });

  it('records PR enrichment timeouts as gaps', async () => {
    const { octokit, rest } = fakeOctokit([{ sha: 'a' }, { sha: 'b' }]);
    rest.repos.listPullRequestsAssociatedWithCommit.mockImplementationOnce(
      (args: { commit_sha: string; request?: { signal: AbortSignal } }) =>
        new Promise((_, reject) => {
          args.request!.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }) as never,
    );
    const out = await run(octokit, { timeoutMs: 50 });
    expect(out.prLookups.get('a')!.landing).toBe('unknown');
    expect(out.prLookups.get('b')!.landing).toBe('unknown');
    expect(rest.repos.listPullRequestsAssociatedWithCommit).toHaveBeenCalledTimes(1);
  });

  it('throws a timeout from a required step', async () => {
    const { octokit, rest } = fakeOctokit([{ sha: 'a' }]);
    rest.repos.listCommits.mockImplementation(
      ({ request }: { page: number; request?: { signal: AbortSignal } }) =>
        new Promise((_, reject) => {
          request!.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }) as never,
    );
    expect((await ingestError(run(octokit, { timeoutMs: 20 }))).code).toBe('timeout');
  });

  it.each([
    ['repos.get', httpError(404), 'not_found'],
    ['listCommits', httpError(403), 'forbidden'],
    ['listCommits', httpError(429), 'rate_limited'],
    ['getCommit', httpError(403, { 'x-ratelimit-remaining': '0' }), 'rate_limited'],
  ] as const)('maps a required %s failure to %s', async (method, error, code) => {
    const { octokit, rest } = fakeOctokit([{ sha: 'a' }]);
    const fn = {
      'repos.get': rest.repos.get,
      listCommits: rest.repos.listCommits,
      getCommit: rest.repos.getCommit,
    }[method] as ReturnType<typeof vi.fn>;
    fn.mockRejectedValueOnce(error);
    expect((await ingestError(run(octokit))).code).toBe(code);
  });

  it('rejects invalid limits by name', async () => {
    const { octokit } = fakeOctokit([]);
    await expect(run(octokit, { maxRequests: 1 })).rejects.toThrow('Invalid collection limit: maxRequests');
  });
});
