import type { Octokit } from '@octokit/rest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CANDIDATE, fixtureCandidate, fixtureRepo, sourceLines } from './candidate-fixtures.js';
import type { PreparedRepo } from './candidate-evidence.js';

// GitHub is mocked at the module boundary: these tests count which selections get fetched.
const fetched: string[] = [];
vi.mock('./ingest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ingest.js')>();
  return {
    ...actual,
    ingestRepo: vi.fn(async (_octokit: unknown, { repo }: { repo: string }) => {
      fetched.push(repo);
      return fixtureRepo(repo, [{ path: 'src/x.ts', content: sourceLines(5) }], []).snapshot;
    }),
  };
});
vi.mock('./contributions.js', () => ({
  collectContributions: vi.fn(
    async (_octokit: unknown, { repo }: { repo: string }) => fixtureRepo(repo, [], []).collected,
  ),
}));

const { effectiveInput, prepareDemoCandidate, transientRepos } = await import('./demo-prepare.js');

const repo = (name: string): PreparedRepo =>
  fixtureRepo(name, [{ path: 'src/a.ts', content: sourceLines(10) }], []);
const sel = (name: string, pinnedSha: string | null = `snap-${name}`) => ({
  owner: 'octo',
  repo: name,
  pinnedSha,
});
const candidate = (repositories = [sel('one'), sel('two')], resumeText: string | null = null) => ({
  key: 'cand',
  githubLogin: 'CAND',
  repositories,
  resumeText,
});
const octokit = {
  rest: { users: { getByUsername: vi.fn(async () => ({ data: { id: 101, login: 'cand' } })) } },
} as unknown as Octokit;

beforeEach(() => {
  fetched.length = 0;
  vi.mocked(octokit.rest.users.getByUsername).mockClear();
});

describe('effectiveInput', () => {
  const prepared = fixtureCandidate([repo('one'), repo('two')], { resume: { text: 'stale' } });

  it('uses the current resume text, never the one embedded in the prepared file', () => {
    const ready = effectiveInput(candidate(undefined, 'current'), prepared);
    expect(ready.kind === 'ready' && ready.prepared.resume).toEqual({ text: 'current' });
    const none = effectiveInput(candidate(), prepared);
    expect(none.kind === 'ready' && none.prepared.resume).toBeNull();
  });

  it('drops deselected repositories and compares logins case-insensitively', () => {
    const result = effectiveInput(candidate([sel('two')]), prepared);
    expect(result.kind === 'ready' && result.prepared.repos.map((r) => r.repo)).toEqual(['two']);
  });

  it('reports missing selections and changed pins as not prepared', () => {
    expect(effectiveInput(candidate([sel('one'), sel('three')]), prepared)).toEqual({
      kind: 'not_prepared',
      missing: [sel('three')],
    });
    expect(
      effectiveInput(candidate([sel('one', 'other-sha'), sel('two')]), prepared),
    ).toMatchObject({
      kind: 'not_prepared',
      missing: [sel('one', 'other-sha')],
    });
  });

  it('rejects preparation for another subject, identity or collector', () => {
    const otherLogin = fixtureCandidate([repo('one'), repo('two')], {
      identity: { ...CANDIDATE, login: 'someone' },
    });
    expect(effectiveInput(candidate(), otherLogin).kind).toBe('not_prepared');
    expect(effectiveInput({ ...candidate(), key: 'other' }, prepared).kind).toBe('not_prepared');
    const foreign = { ...repo('one'), collectedFor: 999 };
    const mixed = fixtureCandidate([foreign, repo('two')]);
    expect(effectiveInput(candidate(), mixed)).toMatchObject({ missing: [sel('one')] });
    const moved = repo('one');
    moved.collected = {
      ...moved.collected,
      repository: { ...moved.collected.repository, repo: 'x' },
    };
    expect(effectiveInput(candidate(), fixtureCandidate([moved, repo('two')]))).toMatchObject({
      missing: [sel('one')],
    });
  });

  it('keeps unavailable repositories as incomplete evidence', () => {
    const partial = fixtureCandidate([
      repo('one'),
      { owner: 'octo', repo: 'two', unavailable: 'not_found', requestedSha: 'snap-two' },
    ]);
    const result = effectiveInput(candidate(), partial);
    expect(result.kind).toBe('ready');
    expect(result.kind === 'ready' && transientRepos(result.prepared)).toEqual([]);
  });

  it('treats an unavailable entry as not prepared once its pin changes', () => {
    const partial = fixtureCandidate([
      repo('one'),
      { owner: 'octo', repo: 'two', unavailable: 'not_found', requestedSha: 'gone' },
    ]);
    expect(effectiveInput(candidate([sel('one'), sel('two', 'gone')]), partial).kind).toBe('ready');
    const repinned = effectiveInput(candidate(), partial);
    expect(repinned).toEqual({ kind: 'not_prepared', missing: [sel('two')] });
  });
});

describe('prepareDemoCandidate', () => {
  it('fetches only missing selections and keeps valid snapshots', async () => {
    const existing = fixtureCandidate([repo('one')]);
    const result = await prepareDemoCandidate(octokit, candidate(), existing, {
      refetchTransient: false,
    });
    expect(fetched).toEqual(['two']);
    expect(octokit.rest.users.getByUsername).not.toHaveBeenCalled();
    expect(result.repos.map((r) => r.repo)).toEqual(['one', 'two']);
    expect(result.resume).toBeNull();
  });

  it('re-fetches transient failures only when asked', async () => {
    const existing = fixtureCandidate([
      repo('one'),
      { owner: 'octo', repo: 'two', unavailable: 'rate_limited', requestedSha: 'snap-two' },
    ]);
    const ready = effectiveInput(candidate(), existing);
    expect(ready.kind === 'ready' && transientRepos(ready.prepared)).toEqual(['octo/two']);
    await prepareDemoCandidate(octokit, candidate(), existing, { refetchTransient: false });
    expect(fetched).toEqual([]);
    await prepareDemoCandidate(octokit, candidate(), existing, { refetchTransient: true });
    expect(fetched).toEqual(['two']);
  });

  it('fetches the new pin for a repository that was unavailable at its old pin', async () => {
    const existing = fixtureCandidate([
      repo('one'),
      { owner: 'octo', repo: 'two', unavailable: 'not_found', requestedSha: 'gone' },
    ]);
    await prepareDemoCandidate(octokit, candidate(), existing, { refetchTransient: false });
    expect(fetched).toEqual(['two']);
  });

  it('starts over when the stored identity does not match the profile', async () => {
    const existing = fixtureCandidate([repo('one'), repo('two')], {
      identity: { ...CANDIDATE, login: 'someone' },
    });
    await prepareDemoCandidate(octokit, candidate(), existing, { refetchTransient: false });
    expect(octokit.rest.users.getByUsername).toHaveBeenCalledOnce();
    expect(fetched).toEqual(['one', 'two']);
  });
});
