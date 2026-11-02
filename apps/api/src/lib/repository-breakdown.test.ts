import type { CandidateAssessment, EvidenceRef, Freshness } from '@clearhire/shared';
import { describe, expect, it } from 'vitest';
import { fixtureCandidate, fixtureRepo, sourceLines } from './candidate-fixtures.js';
import { buildRepositoryBreakdown, evidenceUrl } from './repository-breakdown.js';

const ONE = { owner: 'octo', repo: 'one', pinnedSha: 'snap-one' };
const TWO = { owner: 'octo', repo: 'two', pinnedSha: 'snap-two' };
const GONE = { owner: 'octo', repo: 'gone', pinnedSha: null };

const prepared = fixtureCandidate([
  fixtureRepo('one', [{ path: 'src/a.ts', content: sourceLines(10) }], []),
  fixtureRepo('two', [{ path: 'src/b.ts', content: sourceLines(10) }], []),
  { owner: 'octo', repo: 'gone', unavailable: 'not_found' },
]);

const ref = (repo: string, path: string, startLine = 1): EvidenceRef => ({
  ref: 'a1',
  repo,
  commitSha: `snap-${repo.split('/')[1]}`,
  path,
  startLine,
  endLine: startLine + 1,
  sha256: 'h',
  attribution: 'sole',
  contributions: [],
  alsoIn: [],
  note: null,
});

const skill = (skillId: string, refs: EvidenceRef[]) => ({
  skillId,
  level: 2 as const,
  confidence: 'high' as const,
  rationale: 'Shown by the cited lines',
  supportingTags: [],
  evidence: refs,
  attributionLimitations: [],
});

function assessment(overrides: Partial<CandidateAssessment> = {}): CandidateAssessment {
  return {
    kind: 'candidate',
    subject: { kind: 'demo', key: 'cand' },
    model: 'muse-spark-1.3',
    catalogue: { id: 'clearhire-skills', version: 3 },
    status: 'complete',
    verification: 'location_verified_not_competency',
    coverage: {
      evidence: 'sampled',
      unavailableRepos: [{ repo: 'octo/gone', reason: 'not_found' }],
      omissions: [
        { repo: 'octo/one', path: 'src/a.ts', reason: 'budget', startLine: 5, endLine: 9 },
      ],
      duplicates: [
        {
          repo: 'octo/two',
          path: 'src/copy.ts',
          commitSha: 'snap-two',
          duplicateOf: 'octo/one:src/a.ts',
        },
      ],
      attributionGaps: [
        { repo: 'octo/two', reason: 'history_capped', commitSha: null, path: null },
      ],
      limitations: [],
    },
    repositories: [
      {
        repo: 'octo/one',
        functionality: [{ summary: 'Serves an API', refs: [ref('octo/one', 'src/a.ts')] }],
        qualityObservations: [
          {
            kind: 'concern',
            observation: 'No input validation',
            refs: [ref('octo/one', 'src/a.ts', 3)],
          },
        ],
        limitations: ['Only one module was visible'],
        contribution: { summary: 'Wrote the handlers', refs: [ref('octo/one', 'src/a.ts')] },
      },
    ],
    skills: [
      skill('api-design', [ref('octo/one', 'src/a.ts')]),
      skill('unit-testing', [ref('octo/one', 'src/a.ts', 5), ref('octo/two', 'src/b.ts')]),
    ],
    unsupportedSkills: [],
    ...overrides,
  };
}

const fresh = (state: Freshness['state'], errorCode: string | null = null): Freshness => ({
  state,
  assessmentStatus: state === 'current' ? 'complete' : null,
  errorCode,
  completedAt: null,
});

const build = (input: Partial<Parameters<typeof buildRepositoryBreakdown>[0]> = {}) =>
  buildRepositoryBreakdown({
    repositories: [ONE, TWO, GONE],
    prepared,
    missing: [],
    freshness: fresh('current'),
    assessment: assessment(),
    ...input,
  });

describe('buildRepositoryBreakdown', () => {
  it('shows each repository only its own findings and evidence', () => {
    const [one, two] = build();
    expect(one).toMatchObject({ state: 'analyzed', commitSha: 'snap-one' });
    expect(one!.functionality[0]!.evidence.map((e) => e.path)).toEqual(['src/a.ts']);
    expect(one!.coverage).toMatchObject({ sampled: true, omittedRanges: 1, attributionGaps: [] });
    // octo/two has no finding of its own, but a skill with evidence there.
    expect(two!.functionality).toEqual([]);
    expect(two!.skills.map((s) => s.skillId)).toEqual(['unit-testing']);
    expect(two!.skills[0]!.evidence.map((e) => e.path)).toEqual(['src/b.ts']);
    expect(two!.coverage.attributionGaps).toEqual([
      { reason: 'history_capped', commitSha: null, path: null },
    ]);
  });

  it('labels skills assessed across several repositories as candidate-wide', () => {
    const [one] = build();
    const scopes = Object.fromEntries(one!.skills.map((s) => [s.skillId, s.levelScope]));
    expect(scopes).toEqual({ 'api-design': 'repository', 'unit-testing': 'candidate_wide' });
    expect(one!.skills[0]!.name).not.toBe('api-design');
  });

  it('reports duplicate copies as file-level notes', () => {
    expect(build()[1]!.duplicates).toEqual([
      { path: 'src/copy.ts', duplicateOf: 'octo/one:src/a.ts' },
    ]);
  });

  it('marks a repository the model did not describe', () => {
    const [, two] = build({ assessment: assessment({ skills: [] }) });
    expect(two).toMatchObject({ state: 'not_described', skills: [] });
  });

  it('keeps unavailable and unprepared repositories visible as incomplete', () => {
    const [one, , gone] = build({ missing: [ONE] });
    expect(one).toMatchObject({ state: 'not_prepared', commitSha: null, skills: [] });
    expect(gone).toMatchObject({ state: 'unavailable', reason: 'not_found' });
  });

  it.each([
    ['pending', 'pending'],
    ['failed', 'failed'],
    ['outdated', 'outdated'],
    ['not_started', 'not_analyzed'],
    ['model_not_configured', 'not_analyzed'],
  ] as const)('never shows stored findings when freshness is %s', (state, expected) => {
    const [one] = build({
      freshness: fresh(state, state === 'failed' ? 'timeout' : null),
      assessment: null,
    });
    expect(one).toMatchObject({ state: expected, functionality: [], skills: [] });
    if (state === 'failed') expect(one!.reason).toBe('timeout');
  });

  it('reports a current no-evidence assessment per repository', () => {
    const none = assessment({ status: 'no_attributed_evidence', repositories: [], skills: [] });
    expect(build({ assessment: none })[0]).toMatchObject({ state: 'no_attributed_evidence' });
  });

  it('links evidence to the pinned commit and encodes awkward paths', () => {
    expect(
      evidenceUrl({
        repo: 'octo/one',
        commitSha: 'abc',
        path: 'docs/a b#c.ts',
        startLine: 3,
        endLine: 9,
      }),
    ).toBe('https://github.com/octo/one/blob/abc/docs/a%20b%23c.ts#L3-L9');
  });
});
