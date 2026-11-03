import type { Octokit } from '@octokit/rest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureRepo, sourceLines } from './candidate-fixtures.js';

// GitHub is mocked at the module boundary: these tests record what each run fetches.
const fetched: { repo: string; ref?: string }[] = [];
vi.mock('./ingest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ingest.js')>();
  return {
    ...actual,
    ingestRepo: vi.fn(async (_octokit: unknown, { repo, ref }: { repo: string; ref?: string }) => {
      fetched.push({ repo, ref });
      if (repo === 'gone') throw Object.assign(new Error('missing'), { status: 404 });
      return fixtureRepo(repo, [{ path: 'src/x.ts', content: sourceLines(5) }], []).snapshot;
    }),
  };
});
vi.mock('./contributions.js', () => ({
  collectContributions: vi.fn(
    async (_octokit: unknown, { repo }: { repo: string }) => fixtureRepo(repo, [], []).collected,
  ),
}));

const { prepareDemoCandidate } = await import('./demo-prepare.js');

const sel = (name: string) => ({ owner: 'octo', repo: name, pinnedSha: `snap-${name}` });
const candidate = (repositories = [sel('one'), sel('two')], resumeText: string | null = null) => ({
  key: 'cand',
  githubLogin: 'CAND',
  repositories,
  resumeText,
});
const octokitFor = (user: { id: number; login: string; type?: string }) =>
  ({
    rest: { users: { getByUsername: vi.fn(async () => ({ data: { type: 'User', ...user } })) } },
  }) as unknown as Octokit;
const octokit = octokitFor({ id: 101, login: 'cand' });

beforeEach(() => {
  fetched.length = 0;
});

describe('prepareDemoCandidate', () => {
  it('fetches every selection at its default-branch head, never the recorded pin', async () => {
    const result = await prepareDemoCandidate(octokit, candidate());
    expect(fetched).toEqual([
      { repo: 'one', ref: undefined },
      { repo: 'two', ref: undefined },
    ]);
    expect(result.repos.map((r) => r.repo)).toEqual(['one', 'two']);
    expect(result).toMatchObject({
      subject: { kind: 'demo', key: 'cand' },
      identity: { githubUserId: 101, login: 'cand' },
      resume: null,
      dataUse: 'approved_public_demo',
    });
  });

  it('fetches again on every run and attaches the current resume text', async () => {
    await prepareDemoCandidate(octokit, candidate([sel('one')]));
    const again = await prepareDemoCandidate(octokit, candidate([sel('one')], 'current'));
    expect(fetched.map((f) => f.repo)).toEqual(['one', 'one']);
    expect(again.resume).toEqual({ text: 'current' });
  });

  it('records a GitHub failure as an unavailable repository', async () => {
    const result = await prepareDemoCandidate(octokit, candidate([sel('one'), sel('gone')]));
    expect(result.repos[1]).toEqual({ owner: 'octo', repo: 'gone', unavailable: 'not_found' });
  });

  it('refuses another account and organization accounts before fetching anything', async () => {
    await expect(
      prepareDemoCandidate(octokitFor({ id: 1, login: 'someone' }), candidate()),
    ).rejects.toMatchObject({ code: 'identity_mismatch' });
    await expect(
      prepareDemoCandidate(octokitFor({ id: 1, login: 'cand', type: 'Organization' }), candidate()),
    ).rejects.toMatchObject({ code: 'organization_account' });
    expect(fetched).toEqual([]);
  });
});
