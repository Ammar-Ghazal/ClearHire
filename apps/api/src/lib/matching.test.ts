import type { CandidateAssessment, JobAssessment } from '@clearhire/shared';
import { describe, expect, it } from 'vitest';
import { MatchError, matchAssessments } from './matching.js';

const CATALOGUE = { id: 'clearhire-skills' as const, version: 2 };
const EVIDENCE = {
  ref: 'a1',
  repo: 'octo/one',
  commitSha: 'sha',
  path: 'src/a.ts',
  startLine: 1,
  endLine: 2,
  sha256: 'h',
  attribution: 'sole' as const,
  contributions: [],
  alsoIn: [],
  note: null,
};
const COMPLETE_COVERAGE: CandidateAssessment['coverage'] = {
  evidence: 'complete',
  unavailableRepos: [],
  omissions: [],
  duplicates: [],
  attributionGaps: [],
  limitations: [],
};

function candidate(
  skills: [string, 1 | 2 | 3, 'low' | 'medium' | 'high'][],
  status: CandidateAssessment['status'] = 'complete',
  coverage = COMPLETE_COVERAGE,
): CandidateAssessment {
  return {
    kind: 'candidate',
    subject: { kind: 'demo', key: 'cand' },
    model: 'muse-spark-1.3',
    catalogue: CATALOGUE,
    status,
    verification: 'location_verified_not_competency',
    coverage,
    repositories: [],
    skills: skills.map(([skillId, level, confidence]) => ({
      skillId,
      level,
      confidence,
      rationale: '',
      supportingTags: [],
      evidence: [EVIDENCE],
      attributionLimitations: [],
    })),
    unsupportedSkills: [],
  };
}

function job(
  requirements: [string, 1 | 2 | 3, number, string[]?][],
  inScope = true,
): JobAssessment {
  return {
    kind: 'job',
    jobKey: 'job-01',
    employerId: 'acme',
    title: 'Engineer',
    model: 'muse-spark-1.3',
    catalogue: CATALOGUE,
    textSource: 'full_description',
    inScope,
    outOfScopeReason: inScope ? null : 'Not software',
    requirements: requirements.map(([skillId, requiredLevel, suggestedPriority, invalid = []]) => ({
      skillId,
      requiredLevel,
      suggestedPriority,
      refs: invalid.length > 0 ? [] : [{ ref: 'j1', text: 'line' }],
      referenceStatus: invalid.length > 0 ? ('needs_review' as const) : ('verified' as const),
      invalidRefs: invalid,
    })),
    eligibilityConstraints: [{ summary: 'Location: Paris', refs: [{ ref: 'j2', text: 'Paris' }] }],
    supportingTags: [],
  };
}

describe('matchAssessments', () => {
  const posting = job([
    ['api-design', 2, 3],
    ['unit-testing', 3, 2],
    ['sql-querying', 3, 1],
    ['debugging', 2, 2],
    ['accessibility', 1, 0],
  ]);

  it('awards full, half and no credit with linear priority weights', () => {
    const result = matchAssessments(
      candidate([
        ['api-design', 3, 'high'],
        ['unit-testing', 2, 'medium'],
        ['sql-querying', 1, 'high'],
      ]),
      posting,
    );
    expect(result.requirements.map((r) => [r.skillId, r.verdict, r.credit])).toEqual([
      ['api-design', 'met', 1],
      ['unit-testing', 'partly_met', 0.5],
      ['sql-querying', 'below_required', 0],
      ['debugging', 'not_demonstrated', 0],
      ['accessibility', 'not_demonstrated', 0],
    ]);
    // Priority 0 is excluded: Σp = 3 + 2 + 1 + 2 = 8.
    expect(result).toMatchObject({
      status: 'scored',
      compatibility: (100 * (3 * 1 + 2 * 0.5)) / 8,
      evidenceCoverage: (100 * (3 + 2 + 1)) / 8,
      provisional: false,
      eligibilityConstraints: ['Location: Paris'],
    });
  });

  it('applies employer overrides and never lets confidence change the score', () => {
    const high = matchAssessments(
      candidate([['api-design', 3, 'high']]),
      posting,
      new Map([['debugging', 0]]),
    );
    const low = matchAssessments(
      candidate([['api-design', 3, 'low']]),
      posting,
      new Map([['debugging', 0]]),
    );
    expect(high.requirements.find((r) => r.skillId === 'debugging')).toMatchObject({
      priority: 0,
      prioritySource: 'override',
    });
    expect(high.status === 'scored' && high.compatibility).toBe((100 * 3) / 6);
    expect(low.status === 'scored' && low.compatibility).toBe(
      high.status === 'scored' && high.compatibility,
    );
  });

  it('scores requirements whose job reference failed verification, flagging them for review', () => {
    const result = matchAssessments(
      candidate([['component-architecture', 2, 'high']]),
      job([
        ['component-architecture', 2, 3],
        ['database-migrations', 2, 3, ['j99']],
      ]),
    );
    expect(result).toMatchObject({ status: 'scored', compatibility: 50 });
    expect(
      result.requirements.map((r) => [r.skillId, r.verdict, r.credit, r.referenceStatus]),
    ).toEqual([
      ['component-architecture', 'met', 1, 'verified'],
      ['database-migrations', 'not_demonstrated', 0, 'needs_review'],
    ]);
  });

  it('makes matches provisional when attribution coverage has gaps', () => {
    const gaps = {
      ...COMPLETE_COVERAGE,
      attributionGaps: [
        { repo: 'octo/one', reason: 'history_capped', commitSha: null, path: null },
      ],
    };
    const result = matchAssessments(
      candidate([], 'no_attributed_evidence', gaps),
      job([['api-design', 2, 3]]),
    );
    expect(result).toMatchObject({ status: 'scored', provisional: true });
  });

  it('marks partial candidates provisional', () => {
    const result = matchAssessments(candidate([], 'partial'), posting);
    expect(result).toMatchObject({ status: 'scored', provisional: true, compatibility: 0 });
  });

  it('marks matches against research notes or a paraphrased posting provisional', () => {
    const summary = { ...posting, textSource: 'fixture_summary' as const };
    const paraphrase = { ...posting, textSource: 'source_summary' as const };
    expect(matchAssessments(candidate([]), posting)).toMatchObject({ provisional: false });
    expect(matchAssessments(candidate([]), summary)).toMatchObject({ provisional: true });
    expect(matchAssessments(candidate([]), paraphrase)).toMatchObject({ provisional: true });
  });

  it('leaves zero-priority and out-of-scope jobs unscored', () => {
    expect(matchAssessments(candidate([]), job([['api-design', 1, 0]]))).toMatchObject({
      status: 'unscored',
      reason: 'zero_priority',
    });
    expect(matchAssessments(candidate([]), job([], false))).toMatchObject({
      status: 'unscored',
      reason: 'out_of_scope',
    });
  });

  it('rejects incompatible catalogue versions', () => {
    const old = { ...posting, catalogue: { ...CATALOGUE, version: 1 } };
    expect(() => matchAssessments(candidate([]), old)).toThrow(MatchError);
  });
});
