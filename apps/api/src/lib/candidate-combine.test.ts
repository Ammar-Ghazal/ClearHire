import type { CandidateAssessment } from '@clearhire/shared';
import { describe, expect, it } from 'vitest';
import {
  applyOverlays,
  combineParts,
  legacyView,
  prefixRefs,
  unionCoverage,
} from './candidate-combine.js';

const ref = (r: string, repo = 'octo/one', commitSha = 'c1') => ({
  ref: r,
  repo,
  commitSha,
  path: `src/${r}.ts`,
  startLine: 1,
  endLine: 2,
  sha256: 's',
  attribution: 'sole' as const,
  contributions: [],
  alsoIn: [],
  note: null,
});
type SkillId = CandidateAssessment['skills'][number]['skillId'];
const skill = (skillId: SkillId, level: 1 | 2 | 3, refs: ReturnType<typeof ref>[]) => ({
  skillId,
  level,
  confidence: 'high' as const,
  rationale: `level ${level}`,
  supportingTags: [],
  evidence: refs,
  attributionLimitations: [],
});
const coverage = (
  extra: Partial<CandidateAssessment['coverage']> = {},
): CandidateAssessment['coverage'] => ({
  evidence: 'complete',
  unavailableRepos: [],
  omissions: [],
  duplicates: [],
  attributionGaps: [],
  limitations: [],
  ...extra,
});
const part = (
  skills: CandidateAssessment['skills'],
  repos: string[] = ['octo/one'],
  cov = coverage(),
): CandidateAssessment => ({
  kind: 'candidate',
  subject: { kind: 'demo', key: 'k' },
  model: 'muse-spark-1.3-contributor',
  catalogue: { id: 'clearhire-skills', version: 1 },
  status: 'complete',
  verification: 'location_verified_not_competency',
  coverage: cov,
  repositories: repos.map((repo) => ({
    repo,
    functionality: [],
    qualityObservations: [],
    limitations: [],
    contribution: null,
  })),
  skills,
  unsupportedSkills: [],
});
const meta = { subject: { kind: 'demo' as const, key: 'k' }, model: 'muse-spark-1.3-contributor' };

describe('combining saved repository parts', () => {
  it('keeps evidence from different rows apart even when their refs are equal', () => {
    const a = prefixRefs(part([skill('unit-testing', 2, [ref('a1')])]), 'row-a');
    const b = prefixRefs(part([skill('unit-testing', 2, [ref('a1', 'octo/two', 'c2')])], ['octo/two']), 'row-b');
    const combined = combineParts([a, b], [], meta);
    expect(combined.skills[0]!.evidence.map((e) => [e.ref, e.repo, e.commitSha])).toEqual([
      ['row-a:a1', 'octo/one', 'c1'],
      ['row-b:a1', 'octo/two', 'c2'],
    ]);
  });

  it('unions coverage, gaps and unavailable repositories, so nothing reads as complete', () => {
    const gap = { repo: 'octo/one', reason: 'history_capped', commitSha: null, path: null };
    const omission = {
      repo: 'octo/two',
      path: 'x.ts',
      reason: 'context_omitted',
      startLine: null,
      endLine: null,
    };
    const merged = unionCoverage(
      [coverage({ attributionGaps: [gap] }), coverage({ omissions: [omission] })],
      [{ repo: 'octo/three', reason: 'not_processed' }],
    );
    expect(merged).toMatchObject({
      evidence: 'sampled',
      attributionGaps: [gap],
      omissions: [omission],
      unavailableRepos: [{ repo: 'octo/three', reason: 'not_processed' }],
    });
    const combined = combineParts(
      [part([skill('unit-testing', 1, [ref('a1')])], ['octo/one'], coverage({ attributionGaps: [gap] }))],
      [{ repo: 'octo/two', reason: 'rate_limited' }],
      meta,
    );
    expect(combined.status).toBe('partial');
    expect(combineParts([], [], meta).status).toBe('no_attributed_evidence');
  });

  it('applies a reassessment to its repository only: up, down, removed or unchanged', () => {
    const one = part([skill('unit-testing', 1, [ref('a1')]), skill('api-design', 2, [ref('a2')])]);
    const two = part([skill('unit-testing', 2, [ref('b1', 'octo/two')])], ['octo/two']);
    const parts = [
      { repo: 'octo/one', assessment: one },
      { repo: 'octo/two', assessment: two },
    ];
    const level = (l: 1 | 2 | 3) => skill('unit-testing', l, [ref('n1', 'octo/one', 'c9')]);
    const levelOf = (o: Parameters<typeof applyOverlays>[1]) =>
      combineParts(applyOverlays(parts, o), [], meta).skills.find((s) => s.skillId === 'unit-testing');
    const overlay = (outcome: 'level' | 'removed' | 'inconclusive', l: 1 | 2 | 3 = 3) => ({
      repo: 'octo/one',
      skillId: 'unit-testing',
      outcome,
      skill: outcome === 'level' ? level(l) : null,
    });
    expect(levelOf([overlay('level', 3)])).toMatchObject({ level: 3 });
    // A lower level in one repository leaves the other repository's higher level standing.
    expect(levelOf([overlay('level', 1)])).toMatchObject({ level: 2, evidence: [{ repo: 'octo/two' }] });
    expect(levelOf([overlay('removed')])!.evidence.every((e) => e.repo === 'octo/two')).toBe(true);
    expect(levelOf([overlay('inconclusive')])).toMatchObject({ level: 2 });
    // The other skill keeps its original evidence and commit throughout.
    const other = combineParts(applyOverlays(parts, [overlay('level', 3)]), [], meta).skills.find(
      (s) => s.skillId === 'api-design',
    );
    expect(other!.evidence).toEqual([ref('a2')]);
  });
});

describe('legacyView', () => {
  const manifest = [
    { repo: 'octo/one', commitSha: 'c1', unavailable: null },
    { repo: 'octo/two', commitSha: 'c2', unavailable: null },
    { repo: 'octo/gone', commitSha: null, unavailable: 'not_found' },
  ];
  const legacy = part(
    [
      skill('unit-testing', 2, [ref('a1')]),
      skill('api-design', 2, [ref('a2'), ref('b1', 'octo/two')]),
      skill('sql', 1, [ref('b2', 'octo/two')]),
    ],
    ['octo/one', 'octo/two'],
    coverage({ evidence: 'sampled' }),
  );

  const skillsOf = (view: ReturnType<typeof legacyView>) =>
    view.parts.flatMap((p) => p.assessment.skills.map((s) => `${p.repo || '*'}:${s.skillId}`)).sort();

  it('covers every usable repository the old run graded, one part each, coverage as recorded', () => {
    const view = legacyView(legacy, manifest, new Set(['octo/one', 'octo/two', 'octo/gone']));
    expect([...view.covered].sort()).toEqual(['octo/one', 'octo/two']);
    expect(view.split.size).toBe(0);
    // The marker spanning both repositories sits in its own part, under no repository.
    expect(skillsOf(view)).toEqual(['*:api-design', 'octo/one:unit-testing', 'octo/two:sql']);
    expect(view.parts.find((p) => p.repo === 'octo/two')!.assessment.repositories).toEqual([
      expect.objectContaining({ repo: 'octo/two' }),
    ]);
    expect(view.parts.every((p) => p.assessment.coverage.evidence === 'sampled')).toBe(true);
  });

  it('drops a marker spanning a repository graded on its own, and flags the rest as split', () => {
    const view = legacyView(legacy, manifest, new Set(['octo/two']));
    expect(skillsOf(view)).toEqual(['octo/two:sql']);
    expect([...view.covered]).toEqual(['octo/two']);
    expect([...view.split]).toEqual(['octo/two']);
  });

  it('applies a reassessment of the second repository to that repository alone', () => {
    const view = legacyView(legacy, manifest, new Set(['octo/one', 'octo/two']), new Set(['octo/two\nsql']));
    const lowered = skill('sql', 1, [ref('n1', 'octo/two', 'c9')]);
    const parts = applyOverlays(view.parts, [
      { repo: 'octo/two', skillId: 'sql', outcome: 'level', skill: lowered },
    ]);
    const combined = combineParts(parts, [], meta);
    expect(combined.skills.find((s) => s.skillId === 'sql')).toMatchObject({ level: 1 });
    // Markers supported by the first repository are untouched.
    expect(combined.skills.map((s) => [s.skillId, s.level]).sort()).toEqual([
      ['api-design', 2],
      ['sql', 1],
      ['unit-testing', 2],
    ]);
  });

  it('a reassessment of a marker spanning repositories releases the others to be graded', () => {
    const view = legacyView(
      legacy,
      manifest,
      new Set(['octo/one', 'octo/two']),
      new Set(['octo/one\napi-design']),
    );
    expect(skillsOf(view)).toEqual(['octo/one:unit-testing', 'octo/two:sql']);
    expect([...view.split]).toEqual(['octo/two']);
  });
});
