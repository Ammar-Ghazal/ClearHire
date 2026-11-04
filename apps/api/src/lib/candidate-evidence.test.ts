import { describe, expect, it } from 'vitest';
import { fixtureCandidate, fixtureRepo, sourceLines } from './candidate-fixtures.js';
import { buildCandidateEvidence, EvidenceInputError } from './candidate-evidence.js';
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
});

describe('dependency context and coverage', () => {
  it('gives manifest names, versions, sections and scripts as context, never as evidence', () => {
    const manifest = JSON.stringify(
      {
        name: 'web-app',
        scripts: { build: 'vite build', test: 'vitest' },
        dependencies: { react: '^19.0.0', zod: '3.23.8' },
        devDependencies: { vitest: '^3.0.0' },
      },
      null,
      2,
    );
    const repo = fixtureRepo(
      'one',
      [
        { path: 'package.json', content: manifest },
        { path: 'requirements.txt', content: 'django==4.2\n' },
        { path: 'src/a.ts', content: sourceLines(10) },
      ],
      [
        { sha: 'c1', path: 'src/a.ts', start: 1, end: 3 },
        { sha: 'c2', path: 'package.json', start: 1, end: 5 },
      ],
    );
    const evidence = buildCandidateEvidence(fixtureCandidate([repo]), LARGE);
    expect(evidence.rendered).toContain(
      'dependencies (context only; installed packages were not sent and prove no skill):\n' +
        '- package.json (npm, web-app): dependencies: react ^19.0.0, zod 3.23.8; ' +
        'devDependencies: vitest ^3.0.0; scripts: build, test\n' +
        '- requirements.txt (requirements): requirements: django ==4.2',
    );
    expect(evidence.items.some((i) => i.path === 'package.json')).toBe(false);
    expect(evidence.citableCount).toBe(1);
    expect(evidence.coverage.evidence).toBe('complete');
  });

  it('keeps attributed code around an oversized line and labels generated exclusions separately', () => {
    const longLine = `export const large = '${'x'.repeat(1001)}';`;
    const repo = fixtureRepo(
      'one',
      [
        { path: 'src/bundle.ts', content: `export const before = 1;\n${longLine}\nexport const after = 2;\n` },
        { path: 'src/generated.ts', content: '// @generated\nexport const generated = 1;\n' },
        { path: 'tests/flow.test.ts', content: "import { a } from 'pkg';\ntest('a', () => {});\n" },
      ],
      [
        { sha: 'c1', path: 'tests/flow.test.ts', start: 1, end: 2 },
        { sha: 'c2', path: 'src/bundle.ts', start: 1, end: 3 },
        { sha: 'c3', path: 'src/generated.ts', start: 1, end: 2 },
      ],
    );
    const evidence = buildCandidateEvidence(fixtureCandidate([repo]), LARGE);
    const attributed = evidence.items.filter((i) => i.kind === 'attributed');
    expect(attributed.filter((i) => i.path === 'src/bundle.ts')).toMatchObject([
      { startLine: 1, endLine: 1 },
      { startLine: 3, endLine: 3 },
    ]);
    expect(attributed.some((i) => i.path === 'tests/flow.test.ts')).toBe(true);
    expect(attributed.some((i) => i.path === 'src/generated.ts')).toBe(false);
    expect(evidence.coverage.omissions).toEqual(expect.arrayContaining([
      { repo: 'octo/one', path: 'src/bundle.ts', reason: 'long_line', startLine: 2, endLine: 2 },
      { repo: 'octo/one', path: 'src/generated.ts', reason: 'generated', startLine: 1, endLine: 2 },
    ]));
    expect(evidence.coverage.omissions).toHaveLength(2);
    expect(evidence.coverage.evidence).toBe('sampled');
  });
});
