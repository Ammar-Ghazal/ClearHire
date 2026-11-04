import { describe, expect, it } from 'vitest';
import {
  attributeContributions,
  conclusivelyNoContributions,
  parseCoauthors,
  type BlameRange,
  type CandidateIdentity,
  type CollectedContributions,
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

/** Blame giving a commit lines 3–4 of src/a.ts at the snapshot. */
const detail = (overrides: Partial<BlameRange> = {}): BlameRange[] => [
  { path: 'src/a.ts', start: 3, end: 4, ...overrides },
];

const NOT_LANDING: PrLookup = { landing: 'not_landing', prNumber: 7 };

function collected(
  commits: CommitSummary[],
  blame: Record<string, BlameRange[]> = {},
  prLookups: Record<string, PrLookup> = {},
): CollectedContributions {
  return {
    repository: { owner: 'octo', repo: 'demo', commitSha: 'snap', fork: false, ownerId: 999 },
    commits,
    blame: new Map(Object.entries(blame)),
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
    expect(c).toMatchObject({ roles: ['committer'], authorship: 'not_author' });
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
    const otherDetail = detail({ start: 11, end: 11 });
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

  it('reports blamed lines of every file, including files others changed later', () => {
    const c = only(
      collected([commit('c1')], { c1: [...detail(), { path: 'src/b.ts', start: 1, end: 1 }] }, {
        c1: NOT_LANDING,
      }),
    );
    expect(c.ranges.map((r) => [r.path, r.start, r.end, r.analysis])).toEqual([
      ['src/a.ts', 3, 4, 'snapshot_chunks'],
      ['src/b.ts', 1, 1, 'unavailable'],
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

describe('landing and coverage', () => {
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
