import type { CandidateAssessment } from '@clearhire/shared';
import { describe, expect, it } from 'vitest';
import type { EvidenceLayout } from './candidate-evidence.js';
import { mergeAssessments, packParts } from './candidate-parts.js';

const file = (key: string, size: number, related: string[] = []) => ({
  key,
  text: 'x'.repeat(size),
  refs: [],
  related,
});

describe('packParts', () => {
  const layout: EvidenceLayout = {
    repos: [
      { header: 'h'.repeat(10), files: [file('0\0a.ts', 40), file('0\0b.ts', 40)] },
      {
        header: 'h'.repeat(10),
        files: [
          file('1\0src/a.ts', 50, ['1\0tests/a.test.ts']),
          file('1\0src/b.ts', 50),
          file('1\0tests/a.test.ts', 30),
        ],
      },
    ],
    unavailable: [],
  };

  it('keeps whole repositories together, then splits a large one by file with its tests', () => {
    const parts = packParts(layout, (t) => t.length, 100);
    expect(parts.map((p) => [...p])).toEqual([
      ['0\0a.ts', '0\0b.ts'],
      ['1\0src/a.ts', '1\0tests/a.test.ts'],
      ['1\0src/b.ts'],
    ]);
  });

  it('sends every file exactly once and keeps each part within the budget', () => {
    const cost = (t: string) => t.length;
    const parts = packParts(layout, cost, 100);
    const keys = parts.flatMap((p) => [...p]);
    const all = layout.repos.flatMap((r) => r.files.map((f) => f.key));
    expect(keys.sort()).toEqual(all.sort());
    expect(packParts(layout, cost, 1_000)).toHaveLength(1);
  });
});

describe('mergeAssessments', () => {
  const ref = (r: string) => ({
    ref: r,
    repo: 'octo/one',
    commitSha: 'c',
    path: `src/${r}.ts`,
    startLine: 1,
    endLine: 2,
    sha256: 's',
    attribution: 'sole' as const,
    contributions: [],
    alsoIn: [],
    note: null,
  });
  const skill = (level: 1 | 2 | 3, r: string, limits: string[] = []) => ({
    skillId: 'unit-testing' as const,
    level,
    confidence: 'high' as const,
    rationale: `level ${level}`,
    supportingTags: [r],
    evidence: [ref(r)],
    attributionLimitations: limits as never[],
  });
  const part = (skills: ReturnType<typeof skill>[], summary: string, r: string) =>
    ({
      kind: 'candidate',
      subject: { kind: 'demo', key: 'k' },
      model: 'muse-spark-1.3-contributor',
      catalogue: { id: 'c', version: 1 },
      status: 'complete',
      verification: 'location_verified_not_competency',
      coverage: {} as never,
      repositories: [
        {
          repo: 'octo/one',
          functionality: [{ summary, refs: [ref(r)] }],
          qualityObservations: [],
          limitations: ['visible files only'],
          contribution: { summary, refs: [ref(r)] },
        },
      ],
      skills,
      unsupportedSkills: [],
    }) as unknown as CandidateAssessment;

  it('keeps the highest supported level and combines evidence at that level', () => {
    const coverage = { evidence: 'complete' } as CandidateAssessment['coverage'];
    const merged = mergeAssessments(
      [
        part([skill(1, 'a1')], 'API', 'a1'),
        part([skill(2, 'a2')], 'Web', 'a2'),
        part([skill(2, 'a3', ['shared_authorship'])], 'Jobs', 'a3'),
      ],
      coverage,
      'complete',
    );
    expect(merged.skills).toHaveLength(1);
    expect(merged.skills[0]).toMatchObject({
      level: 2,
      rationale: 'level 2',
      supportingTags: ['a2', 'a3'],
      attributionLimitations: ['shared_authorship'],
    });
    expect(merged.skills[0]!.evidence.map((e) => e.ref)).toEqual(['a2', 'a3']);
    expect(merged.repositories).toHaveLength(1);
    expect(merged.repositories[0]!.functionality.map((f) => f.summary)).toEqual([
      'API',
      'Web',
      'Jobs',
    ]);
    expect(merged.repositories[0]!.limitations).toEqual(['visible files only']);
    expect(merged.repositories[0]!.contribution!.refs.map((r) => r.ref)).toEqual([
      'a1',
      'a2',
      'a3',
    ]);
    expect(merged).toMatchObject({ status: 'complete', coverage });
  });
});
