import { describe, expect, it } from 'vitest';
import { verifyCandidate, verifyJob } from './assessment-verify.js';
import { buildCandidateEvidence } from './candidate-evidence.js';
import { fixtureCandidate, fixtureRepo, sourceLines } from './candidate-fixtures.js';
import type { CandidateOutput, JobOutput } from './muse.js';

const repo = fixtureRepo(
  'one',
  [{ path: 'src/a.ts', content: sourceLines(150) }],
  [
    { sha: 'sole', path: 'src/a.ts', start: 10, end: 20 },
    { sha: 'shared', path: 'src/a.ts', start: 130, end: 135, shared: true },
  ],
);
const evidence = buildCandidateEvidence(fixtureCandidate([repo]), { evidenceChars: 1_000_000 });
const META = { subject: { kind: 'demo' as const, key: 'cand' }, model: 'muse-spark-1.3' as const };

const skill = (
  skill_id: string,
  refs: string[],
  level: 1 | 2 | 3 = 2,
): CandidateOutput['skills'][number] => ({
  skill_id,
  level,
  confidence: 'medium',
  justification: 'Shown',
  supporting_tags: ['TypeScript'],
  evidence_refs: refs,
});

function output(overrides: Partial<CandidateOutput> = {}): CandidateOutput {
  return {
    repositories: [
      {
        repo: 'r1',
        functionality: [
          { summary: 'Exports constants', refs: ['c1'] },
          { summary: 'Invented', refs: ['c99'] },
        ],
        quality_observations: [{ kind: 'strength', observation: 'Consistent', refs: ['c1', 'a1'] }],
        limitations: ['Small sample'],
        contribution: { summary: 'Wrote lines 10-20', refs: ['c1'] },
      },
    ],
    skills: [],
    ...overrides,
  };
}

describe('verifyCandidate', () => {
  it('keeps only claims whose references all resolve, and renders them from stored evidence', () => {
    const result = verifyCandidate(
      output({ skills: [skill('unit-testing', ['a1']), skill('algorithms', ['a1', 'a99'], 3)] }),
      evidence,
      META,
    );
    expect(result.status).toBe('complete');
    expect(result.verification).toBe('location_verified_not_competency');
    expect(result.repositories[0]!.functionality.map((f) => f.summary)).toEqual([
      'Exports constants',
    ]);
    expect(result.repositories[0]!.qualityObservations).toHaveLength(1);
    expect(result.repositories[0]!.contribution).toBeNull();

    expect(result.skills.map((s) => s.skillId)).toEqual(['unit-testing']);
    const item = evidence.items.find((i) => i.ref === 'a1')!;
    expect(result.skills[0]!.evidence[0]).toMatchObject({
      ref: 'a1',
      path: 'src/a.ts',
      startLine: item.startLine,
      endLine: item.endLine,
      sha256: item.sha256,
      note: null,
    });
    expect(result.skills[0]!.rationale).toBe('Shown');
    expect(result.unsupportedSkills).toEqual([
      { skillId: 'algorithms', level: 3, invalidRefs: ['a99'] },
    ]);
  });

  it('never supports a skill with context, unknown or resume-only evidence', () => {
    const result = verifyCandidate(
      output({ skills: [skill('api-design', ['c1']), skill('debugging', [])] }),
      evidence,
      META,
    );
    expect(result.skills).toEqual([]);
    expect(result.unsupportedSkills.map((s) => s.skillId)).toEqual(['api-design', 'debugging']);
  });

  it('derives attribution limitations from the cited segments', () => {
    const shared = evidence.items.find((i) => i.attribution === 'shared')!;
    const result = verifyCandidate(
      output({ skills: [skill('refactoring', [shared.ref])] }),
      evidence,
      META,
    );
    expect(result.skills[0]!.attributionLimitations).toEqual(['shared_authorship']);
  });

  it("credits a repository contribution only from that repository's own history", () => {
    const content = sourceLines(30);
    const a = fixtureRepo('alpha', [{ path: 'src/a.ts', content }], []);
    const b = fixtureRepo(
      'beta',
      [{ path: 'lib/copy.ts', content }],
      [{ sha: 'cb', path: 'lib/copy.ts', start: 5, end: 9 }],
    );
    const dedup = buildCandidateEvidence(fixtureCandidate([a, b]), { evidenceChars: 1_000_000 });
    const segment = dedup.items.find((i) => i.kind === 'attributed')!;
    expect(segment).toMatchObject({ repo: 'octo/alpha', path: 'src/a.ts' });

    const claim = { summary: 'Wrote it', refs: [segment.ref] };
    const repoOutput = (repo: string) => ({
      repo,
      functionality: [],
      quality_observations: [],
      limitations: [],
      contribution: claim,
    });
    const result = verifyCandidate(
      {
        repositories: [repoOutput('r1'), repoOutput('r2')],
        skills: [skill('debugging', [segment.ref])],
      },
      dedup,
      META,
    );
    expect(result.repositories.map((r) => [r.repo, r.contribution !== null])).toEqual([
      ['octo/alpha', false],
      ['octo/beta', true],
    ]);
    const ref = result.skills[0]!.evidence[0]!;
    expect(ref.contributions).toEqual([
      expect.objectContaining({ repo: 'octo/beta', path: 'lib/copy.ts', snapshotSha: 'snap-beta' }),
    ]);
    expect(ref.alsoIn).toEqual([
      { repo: 'octo/beta', path: 'lib/copy.ts', commitSha: 'snap-beta' },
    ]);
  });

  it('marks assessments partial when the contribution report has gaps', () => {
    const capped = fixtureRepo(
      'one',
      [{ path: 'src/a.ts', content: sourceLines(20) }],
      [{ sha: 'c1', path: 'src/a.ts', start: 1, end: 3 }],
    );
    capped.collected.gaps.push({ reason: 'history_capped' });
    const withGaps = buildCandidateEvidence(fixtureCandidate([capped]), {
      evidenceChars: 1_000_000,
    });
    const result = verifyCandidate(output(), withGaps, META);
    expect(result.status).toBe('partial');
    expect(result.coverage.attributionGaps).toEqual([
      { repo: 'octo/one', reason: 'history_capped', commitSha: null, path: null },
    ]);
    expect(result.coverage.limitations).toEqual([
      { repo: 'octo/one', limitation: 'squash_hidden_contributions_not_discovered' },
    ]);
  });

  it('rejects repeated skill IDs', () => {
    expect(() =>
      verifyCandidate(
        output({ skills: [skill('debugging', ['a1']), skill('debugging', ['a1'])] }),
        evidence,
        META,
      ),
    ).toThrow(expect.objectContaining({ code: 'duplicate_skill_ids' }));
  });
});

describe('verifyJob', () => {
  const job = {
    jobKey: 'job-01',
    employerId: 'acme',
    title: 'Engineer',
    textSource: 'full_description' as const,
    text: 'Build APIs\n\nWrite unit tests\nUS work authorisation required',
  };
  const base: JobOutput = {
    in_scope: true,
    out_of_scope_reason: null,
    requirements: [
      { skill_id: 'api-design', required_level: 2, suggested_priority: 3, refs: ['j1'] },
      { skill_id: 'unit-testing', required_level: 1, suggested_priority: 2, refs: ['j2', 'j9'] },
    ],
    eligibility_constraints: [{ summary: 'US work authorisation', refs: ['j3'] }],
    supporting_tags: ['Python'],
  };

  it('keeps every requirement, quoting valid references and flagging invalid ones for review', () => {
    const result = verifyJob(base, job, 'muse-spark-1.3');
    expect(result.requirements).toEqual([
      {
        skillId: 'api-design',
        requiredLevel: 2,
        suggestedPriority: 3,
        refs: [{ ref: 'j1', text: 'Build APIs' }],
        referenceStatus: 'verified',
        invalidRefs: [],
      },
      {
        skillId: 'unit-testing',
        requiredLevel: 1,
        suggestedPriority: 2,
        refs: [{ ref: 'j2', text: 'Write unit tests' }],
        referenceStatus: 'needs_review',
        invalidRefs: ['j9'],
      },
    ]);
    expect(result.eligibilityConstraints[0]!.refs[0]!.text).toBe('US work authorisation required');
  });

  it('rejects duplicate skill IDs instead of merging them', () => {
    const duplicated = {
      ...base,
      requirements: [
        base.requirements[0]!,
        { ...base.requirements[0]!, required_level: 3 as const },
      ],
    };
    expect(() => verifyJob(duplicated, job, 'muse-spark-1.3')).toThrow(
      expect.objectContaining({ code: 'duplicate_skill_ids' }),
    );
  });

  it('records out-of-scope roles without discarding their requirements', () => {
    const result = verifyJob(
      { ...base, in_scope: false, out_of_scope_reason: 'Nursing role' },
      job,
      'muse-spark-1.3',
    );
    expect(result).toMatchObject({ inScope: false, outOfScopeReason: 'Nursing role' });
    expect(result.requirements).toHaveLength(2);
  });
});
