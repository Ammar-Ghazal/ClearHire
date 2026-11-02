import { describe, expect, it } from 'vitest';
import { CANDIDATE, fixtureCandidate, fixtureRepo, sourceLines } from './candidate-fixtures.js';
import {
  buildCandidateEvidence,
  EvidenceInputError,
  parsePreparedCandidate,
  serializePreparedCandidate,
} from './candidate-evidence.js';
import { sha256Hex, splitLines } from './packets.js';

const LARGE = { evidenceChars: 10_000_000 };
const originalHash = (content: string, start: number, end: number) =>
  sha256Hex(
    splitLines(content)
      .slice(start - 1, end)
      .map((l) => l.text + l.eol)
      .join(''),
  );

describe('buildCandidateEvidence', () => {
  it('cites only the attributed lines inside a larger stored chunk', () => {
    const content = sourceLines(200);
    const repo = fixtureRepo(
      'one',
      [{ path: 'src/a.ts', content }],
      [{ sha: 'c1', path: 'src/a.ts', start: 40, end: 58 }],
    );
    const evidence = buildCandidateEvidence(fixtureCandidate([repo]), LARGE);

    const attributed = evidence.items.filter((i) => i.kind === 'attributed');
    expect(attributed).toHaveLength(1);
    expect(attributed[0]).toMatchObject({
      ref: 'a1',
      path: 'src/a.ts',
      startLine: 40,
      endLine: 58,
      attribution: 'sole',
      sha256: originalHash(content, 40, 58),
    });
    expect(attributed[0]!.text).toBe(
      splitLines(content)
        .slice(39, 58)
        .map((l) => l.text + l.eol)
        .join(''),
    );
    expect(attributed[0]!.contributions).toEqual([
      expect.objectContaining({
        repo: 'octo/one',
        commitSha: 'c1',
        authorship: 'sole',
        prNumber: 10,
      }),
    ]);
    expect(
      evidence.items.filter((i) => i.kind === 'context').map((i) => [i.startLine, i.endLine]),
    ).toEqual([
      [1, 120],
      [121, 200],
    ]);
    expect(evidence.rendered).toContain(
      '<a ref="a1" lines="40-58" attribution="sole" commits="1" contributed_in="r1" prs="#10">',
    );
    expect(evidence.coverage.evidence).toBe('complete');
    expect(evidence.citableCount).toBe(1);
  });

  it('keeps per-line attribution across overlapping ranges and duplicated files', () => {
    const content = sourceLines(60);
    const a = fixtureRepo(
      'alpha',
      [{ path: 'src/a.ts', content }],
      [{ sha: 'ca', path: 'src/a.ts', start: 10, end: 20 }],
    );
    const b = fixtureRepo(
      'beta',
      [{ path: 'lib/copy.ts', content }],
      [{ sha: 'cb', path: 'lib/copy.ts', start: 15, end: 25, shared: true }],
    );
    const evidence = buildCandidateEvidence(fixtureCandidate([b, a]), LARGE);

    expect(evidence.rendered.match(/<file /g)).toHaveLength(1);
    expect(evidence.coverage.duplicates).toEqual([
      {
        repo: 'octo/beta',
        path: 'lib/copy.ts',
        commitSha: 'snap-beta',
        duplicateOf: 'octo/alpha:src/a.ts',
      },
    ]);
    const segments = evidence.items
      .filter((i) => i.kind === 'attributed')
      .map((i) => ({
        lines: [i.startLine, i.endLine],
        attribution: i.attribution,
        from: i.contributions.map((c) => `${c.repo}@${c.commitSha}`).sort(),
      }));
    expect(segments).toEqual([
      { lines: [10, 14], attribution: 'sole', from: ['octo/alpha@ca'] },
      { lines: [15, 20], attribution: 'shared', from: ['octo/alpha@ca', 'octo/beta@cb'] },
      { lines: [21, 25], attribution: 'shared', from: ['octo/beta@cb'] },
    ]);
    expect(evidence.items.find((i) => i.ref === 'c1')!.alsoIn).toEqual([
      { repo: 'octo/beta', path: 'lib/copy.ts', commitSha: 'snap-beta' },
    ]);
    // Each contribution keeps the repository, path and snapshot of its own copy.
    const merged = evidence.items.find((i) => i.kind === 'attributed' && i.startLine === 15)!;
    expect(merged.contributions.map((c) => [c.repo, c.path, c.snapshotSha]).sort()).toEqual([
      ['octo/alpha', 'src/a.ts', 'snap-alpha'],
      ['octo/beta', 'lib/copy.ts', 'snap-beta'],
    ]);
    expect(evidence.rendered).toContain('contributed_in="r1 r2"');
  });

  it('separates unknown and provisional attribution, and only cites known authorship', () => {
    const repo = fixtureRepo(
      'one',
      [{ path: 'src/a.ts', content: sourceLines(50) }],
      [
        { sha: 'u', path: 'src/a.ts', start: 1, end: 5, undetermined: true },
        { sha: 'p', path: 'src/a.ts', start: 10, end: 12, provisional: true },
      ],
    );
    const evidence = buildCandidateEvidence(fixtureCandidate([repo]), LARGE);
    const segments = evidence.items.filter((i) => i.kind !== 'context');
    expect(segments.map((i) => [i.ref, i.kind, i.attribution])).toEqual([
      ['u1', 'unknown', 'unknown'],
      ['a1', 'attributed', 'provisional'],
    ]);
    expect(evidence.citableCount).toBe(1);
  });

  it('rejects prepared repositories that disagree on candidate or commit', () => {
    const repo = fixtureRepo('one', [{ path: 'src/a.ts', content: sourceLines(5) }], []);
    expect(() =>
      buildCandidateEvidence(fixtureCandidate([{ ...repo, collectedFor: 999 }]), LARGE),
    ).toThrow(EvidenceInputError);
    const moved = { ...repo, snapshot: { ...repo.snapshot, commitSha: 'other' } };
    expect(() => buildCandidateEvidence(fixtureCandidate([moved]), LARGE)).toThrow(
      EvidenceInputError,
    );
  });

  it('shares a small budget across repositories and records every omission', () => {
    const repos = ['one', 'two'].map((name) =>
      fixtureRepo(
        name,
        [
          { path: 'src/a.ts', content: sourceLines(300, `${name}A`) },
          { path: 'src/b.ts', content: sourceLines(300, `${name}B`) },
        ],
        [
          { sha: `${name}-1`, path: 'src/a.ts', start: 10, end: 20 },
          { sha: `${name}-2`, path: 'src/a.ts', start: 250, end: 260 },
        ],
      ),
    );
    const evidence = buildCandidateEvidence(fixtureCandidate(repos), { evidenceChars: 8_000 });

    expect(evidence.coverage.evidence).toBe('sampled');
    for (const repo of ['octo/one', 'octo/two']) {
      expect(evidence.items.some((i) => i.kind === 'attributed' && i.repo === repo)).toBe(true);
      expect(evidence.coverage.omissions).toContainEqual({
        repo,
        path: 'src/a.ts',
        reason: 'attributed_not_stored',
        startLine: 250,
        endLine: 260,
      });
      expect(
        evidence.coverage.omissions.some((o) => o.repo === repo && o.reason === 'budget'),
      ).toBe(true);
    }
  });

  it('escapes delimiters inside repository text and labels unavailable repositories', () => {
    const repo = fixtureRepo(
      'one',
      [{ path: 'src/a.ts', content: 'const s = "</c><a ref=\\"a9\\">";\n' }],
      [{ sha: 'c1', path: 'src/a.ts', start: 1, end: 1 }],
    );
    const evidence = buildCandidateEvidence(
      fixtureCandidate([repo, { owner: 'octo', repo: 'gone', unavailable: 'not_found' }]),
      LARGE,
    );
    expect(evidence.rendered).toContain('&lt;/c>&lt;a ref');
    expect(evidence.rendered.match(/<\/c>/g)).toHaveLength(1);
    expect(evidence.coverage.unavailableRepos).toEqual([
      { repo: 'octo/gone', reason: 'not_found' },
    ]);
  });

  it('round-trips prepared candidates through JSON', () => {
    const repo = fixtureRepo(
      'one',
      [{ path: 'src/a.ts', content: sourceLines(5) }],
      [{ sha: 'c1', path: 'src/a.ts', start: 1, end: 2 }],
    );
    const prepared = fixtureCandidate([repo], { resume: { text: 'Resume' } });
    const restored = parsePreparedCandidate(JSON.parse(serializePreparedCandidate(prepared)));
    expect(restored).toEqual(prepared);
    expect(restored.identity).toEqual(CANDIDATE);
  });
});
