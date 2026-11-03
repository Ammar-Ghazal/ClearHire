import { describe, expect, it } from 'vitest';
import {
  attributeContributions,
  conclusivelyNoContributions,
  parseCoauthors,
  type CandidateIdentity,
  type CollectedContributions,
  type CommitDetail,
  type CommitSummary,
  type PrLookup,
} from './attribution.js';
import type { RepoSnapshot } from './ingest.js';
import { buildPackets } from './packets.js';

const CANDIDATE: CandidateIdentity = {
  githubUserId: 101,
  login: 'cand',
  verifiedEmails: ['Cand@Example.com'],
};
const ME = { id: 101, login: 'cand', type: 'User' };
const OTHER = { id: 202, login: 'other', type: 'User' };
const WEB_FLOW = { id: 19864447, login: 'web-flow', type: 'User' };

const SOURCE = Array.from({ length: 30 }, (_, i) => `export const v${i + 1} = ${i + 1};\n`).join('');
const snapshot: RepoSnapshot = {
  commitSha: 'snap',
  files: [{ path: 'src/a.ts', sha: 'blob-a', content: SOURCE }],
  skipped: [],
};
const packets = buildPackets(snapshot, { owner: 'octo', repo: 'demo' });

function commit(sha: string, overrides: Partial<CommitSummary> = {}): CommitSummary {
  return {
    sha,
    parents: ['parent'],
    message: 'Change',
    author: { name: 'Cand', email: 'cand@example.com' },
    authorAccount: ME,
    committer: { name: 'GitHub', email: 'noreply@github.com' },
    committerAccount: WEB_FLOW,
    ...overrides,
  };
}

const withTrailers = (...trailers: string[]) => `Change\n\nBody text.\n\n${trailers.join('\n')}`;

/** A one-file detail adding lines 3–4 of src/a.ts. */
function detail(overrides: Partial<CommitDetail['files'][number]> = {}): CommitDetail {
  return {
    outcome: 'complete',
    files: [
      {
        path: 'src/a.ts',
        status: 'modified',
        sha: 'blob-a',
        changes: 2,
        patch: '@@ -2,2 +2,4 @@\n line\n+added\n+added\n line',
        ...overrides,
      },
    ],
  };
}

const NOT_LANDING: PrLookup = { landing: 'not_landing', prNumber: 7 };

function collected(
  commits: CommitSummary[],
  details: Record<string, CommitDetail> = {},
  prLookups: Record<string, PrLookup> = {},
): CollectedContributions {
  return {
    repository: { owner: 'octo', repo: 'demo', commitSha: 'snap', fork: false, ownerId: 999 },
    commits,
    details: new Map(Object.entries(details)),
    prLookups: new Map(Object.entries(prLookups)),
    gaps: [],
    requestsUsed: 0,
  };
}

function report(data: CollectedContributions, context = { snapshot, packets }) {
  return attributeContributions(data, CANDIDATE, context);
}

function only(data: CollectedContributions) {
  const { contributions } = report(data);
  expect(contributions).toHaveLength(1);
  return contributions[0]!;
}

describe('identity', () => {
  it.each([
    ['linked_account', {}],
    ['account_email', { authorAccount: null, author: { name: 'C', email: 'CAND@example.com ' } }],
    [
      'noreply_id',
      { authorAccount: null, author: { name: 'C', email: '101+cand@users.noreply.github.com' } },
    ],
  ] as const)('records the %s match method', (method, overrides) => {
    const c = only(collected([commit('c1', overrides)], { c1: detail() }, { c1: NOT_LANDING }));
    expect(c.roles).toEqual(['author']);
    expect(c.matchMethods).toEqual([method]);
    expect(c.authorship).toBe('sole');
  });

  it.each([
    ['an unmatched email', { name: 'Cand', email: 'cand@elsewhere.com' }],
    ['a legacy username noreply', { name: 'Cand', email: 'cand@users.noreply.github.com' }],
    ['a null identity', null],
  ])('never treats %s on an unlinked author as the candidate', (_, author) => {
    expect(report(collected([commit('c1', { author, authorAccount: null })])).contributions).toEqual(
      [],
    );
  });

  it('lets a different linked account win over a matching email', () => {
    const data = collected([commit('c1', { authorAccount: OTHER })]);
    expect(report(data).contributions).toEqual([]);
  });

  it('resolves noreply ids and unknown coauthors without crediting the candidate', () => {
    const message = withTrailers(
      'Co-authored-by: Someone <202+someone@users.noreply.github.com>',
      'Co-authored-by: Mystery <mystery@example.com>',
    );
    const c = only(collected([commit('c1', { message })], { c1: detail() }, { c1: NOT_LANDING }));
    expect(c.others).toEqual([
      { role: 'committer', kind: 'bot', accountId: 19864447 },
      { role: 'coauthor', kind: 'other', accountId: 202 },
      { role: 'coauthor', kind: 'unknown', email: 'mystery@example.com' },
    ]);
    expect(c.authorship).toBe('shared');
  });

  it('records committer-only commits as not_author with no ranges', () => {
    const c = only(
      collected([commit('c1', { authorAccount: OTHER, committerAccount: ME })], { c1: detail() }),
    );
    expect(c).toMatchObject({ roles: ['committer'], authorship: 'not_author', patch: 'not_fetched' });
    expect(c.ranges).toEqual([]);
  });

  it('attributes a root commit with no parents', () => {
    const c = only(collected([commit('c1', { parents: [] })], { c1: detail() }, { c1: NOT_LANDING }));
    expect(c.parents).toEqual([]);
    expect(c.authorship).toBe('sole');
    expect(c.ranges.map((r) => [r.start, r.end])).toEqual([[3, 4]]);
  });

  it('parses trailers only from the final paragraph and dedupes by email', () => {
    expect(parseCoauthors('Co-authored-by: A <a@x.io>')).toEqual([]);
    expect(
      parseCoauthors('Subject\n\nco-authored-by: A <a@x.io>\nCo-Authored-By: A2 <A@x.io>\r\n'),
    ).toEqual([{ name: 'A', email: 'a@x.io' }]);
  });
});

describe('shared work', () => {
  it('shares work with a human coauthor and with the candidate as coauthor only', () => {
    const coauthored = commit('c1', {
      message: withTrailers('Co-authored-by: Other <other@example.com>'),
    });
    const asCoauthor = commit('c2', {
      authorAccount: OTHER,
      message: withTrailers('Co-authored-by: Cand <cand@example.com>'),
    });
    const { contributions } = report(
      collected([coauthored, asCoauthor], { c1: detail(), c2: detail() }, {
        c1: NOT_LANDING,
        c2: NOT_LANDING,
      }),
    );
    expect(contributions.map((c) => [c.roles, c.authorship])).toEqual([
      [['author'], 'shared'],
      [['coauthor'], 'shared'],
    ]);
  });

  it('records a declared AI coauthor without changing authorship', () => {
    const declared = commit('c1', {
      message: withTrailers('Co-authored-by: Claude <noreply@anthropic.com>'),
    });
    const undeclared = commit('c2');
    const { contributions } = report(
      collected([declared, undeclared], { c1: detail(), c2: detail() }, {
        c1: NOT_LANDING,
        c2: NOT_LANDING,
      }),
    );
    expect(contributions.map((c) => [c.authorship, c.aiCoauthorDeclared])).toEqual([
      ['sole', true],
      ['sole', false],
    ]);
    expect(contributions[0]!.others).toContainEqual({
      role: 'coauthor',
      kind: 'ai_declared',
      email: 'noreply@anthropic.com',
    });
  });

  it('downgrades a landing whose PR has another author, and keeps a candidate-only landing', () => {
    const prBy = (account: typeof ME) => [commit('pr-1'), commit('pr-2', { authorAccount: account })];
    const { contributions } = report(
      collected([commit('c1'), commit('c2')], { c1: detail(), c2: detail() }, {
        c1: { landing: 'landing', prNumber: 1, prCommits: prBy(OTHER) },
        c2: { landing: 'landing', prNumber: 2, prCommits: prBy(ME) },
      }),
    );
    expect(contributions.map((c) => [c.prNumber, c.authorship, c.provisional])).toEqual([
      [1, 'undetermined', false],
      [2, 'sole', false],
    ]);
  });

  it('gives two authors of one file only their own ranges', () => {
    const otherDetail = detail({ patch: '@@ -10,1 +10,2 @@\n line\n+theirs' });
    const { contributions } = report(
      collected([commit('c1'), commit('c2', { authorAccount: OTHER })], {
        c1: detail(),
        c2: otherDetail,
      }),
    );
    expect(contributions).toHaveLength(1);
    expect(contributions[0]!.ranges.map((r) => [r.start, r.end])).toEqual([[3, 4]]);
  });
});

describe('snapshot mapping', () => {
  const chunkId = packets.chunks[0]!.id;

  it('links exact ranges to snapshot chunks as context, keeping only the changed lines', () => {
    expect(packets.chunks[0]).toMatchObject({ startLine: 1, endLine: 30 });
    const c = only(collected([commit('c1')], { c1: detail() }, { c1: NOT_LANDING }));
    expect(c.ranges).toEqual([
      {
        path: 'src/a.ts',
        start: 3,
        end: 4,
        mapping: 'exact',
        analysis: 'snapshot_chunks',
        chunkIds: [chunkId],
      },
    ]);
  });

  it('marks later-edited, deleted and unchunked ranges unavailable', () => {
    const { contributions } = report(
      collected([commit('c1'), commit('c2'), commit('c3')], {
        c1: detail({ sha: 'blob-old' }),
        c2: detail({ patch: '@@ -5,3 +5,1 @@\n line\n-gone\n-gone' }),
        c3: detail({ path: 'src/removed.ts', sha: 'blob-x' }),
      }),
      { snapshot, packets: { ...packets, chunks: [] } },
    );
    expect(contributions.flatMap((c) => c.ranges)).toEqual([
      { path: 'src/a.ts', start: 3, end: 4, mapping: 'historical', analysis: 'unavailable', chunkIds: [] },
      { path: 'src/a.ts', start: 6, end: 7, mapping: 'deleted', analysis: 'unavailable', chunkIds: [] },
      {
        path: 'src/removed.ts',
        start: 3,
        end: 4,
        mapping: 'historical',
        analysis: 'unavailable',
        chunkIds: [],
      },
    ]);
  });

  it('records an exact match with no overlapping chunk as unavailable', () => {
    const { contributions } = report(collected([commit('c1')], { c1: detail() }), {
      snapshot,
      packets: { ...packets, chunks: [] },
    });
    expect(contributions[0]!.ranges[0]).toMatchObject({ mapping: 'exact', analysis: 'unavailable' });
  });

  it('rejects a snapshot from a different commit', () => {
    expect(() => report(collected([]), { snapshot: { ...snapshot, commitSha: 'x' }, packets })).toThrow(
      RangeError,
    );
  });

  it('rejects packets labelled as a different repository, even at the same commit', () => {
    expect(() => report(collected([]), {
      snapshot,
      packets: { ...packets, repository: { owner: 'someone', repo: 'fork' } },
    })).toThrow(RangeError);
  });
});

describe('patch states and coverage', () => {
  it('keeps excluded and rename-only files out of missing patches', () => {
    const c = only(
      collected(
        [commit('c1')],
        {
          c1: {
            outcome: 'complete',
            files: [
              { path: 'node_modules/x/index.js', status: 'modified', sha: 's1', changes: 9 },
              { path: 'pnpm-lock.yaml', status: 'modified', sha: 's2', changes: 9 },
              { path: 'src/moved.ts', status: 'renamed', sha: 's3', changes: 0 },
            ],
          },
        },
        { c1: NOT_LANDING },
      ),
    );
    expect(c.patch).toBe('complete');
  });

  it('marks missing patches, failed and capped details partial, and skipped details not_fetched', () => {
    const data = collected([commit('c1'), commit('c2'), commit('c3'), commit('c4')], {
      c1: detail({ path: 'src/data.unknownext', patch: undefined }),
      c2: { outcome: 'failed', files: [] },
      c3: { ...detail(), outcome: 'files_capped' },
    });
    const out = report(data);
    expect(out.contributions.map((c) => c.patch)).toEqual([
      'partial',
      'partial',
      'partial',
      'not_fetched',
    ]);
    expect(out.coverage.gaps).toEqual([
      { reason: 'patch_missing', commitSha: 'c1', path: 'src/data.unknownext' },
    ]);
  });

  it('keeps candidate-only commits provisional until the PR check completes', () => {
    const c = only(collected([commit('c1')], { c1: detail() }));
    expect(c).toMatchObject({ authorship: 'sole', landing: 'unknown', provisional: true });
  });

  it('counts merge commits without attributing them', () => {
    const out = report(collected([commit('m1', { parents: ['a', 'b'] })]));
    expect(out.contributions).toEqual([]);
    expect(out.coverage.mergeCommits).toBe(1);
  });

  it('always reports the squash discovery limitation and gives ownership no credit', () => {
    const data = collected([]);
    data.repository.ownerId = CANDIDATE.githubUserId;
    data.repository.fork = true;
    const out = report(data);
    expect(out.limitations).toEqual(['squash_hidden_contributions_not_discovered']);
    expect(out.repository).toMatchObject({ fork: true, ownerIsCandidate: true });
    expect(out.contributions).toEqual([]);
  });
});

describe('conclusivelyNoContributions', () => {
  const linkedOther = commit('o1', { authorAccount: OTHER, author: { name: 'O', email: 'o@x.test' } });

  it('holds only for gap-free history without the candidate or any unresolved author', () => {
    expect(conclusivelyNoContributions(collected([linkedOther]), CANDIDATE)).toBe(true);
    expect(conclusivelyNoContributions(collected([]), CANDIDATE)).toBe(true);
  });

  it('fails when the candidate authored anything, history is capped, or an author is unknown', () => {
    expect(conclusivelyNoContributions(collected([commit('mine')]), CANDIDATE)).toBe(false);
    const capped = { ...collected([linkedOther]), gaps: [{ reason: 'history_capped' as const }] };
    expect(conclusivelyNoContributions(capped, CANDIDATE)).toBe(false);
    // An unlinked email could be the candidate's unverified address.
    const unlinked = commit('u1', { authorAccount: null, author: { name: 'U', email: 'u@x.test' } });
    expect(conclusivelyNoContributions(collected([unlinked]), CANDIDATE)).toBe(false);
  });
});
