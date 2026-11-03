// Scores a saved candidate assessment against a saved job assessment. Pure: no model calls, and
// confidence is passed through for display only.
import type { CandidateAssessment, JobAssessment, MatchResult } from '@clearhire/shared';
import { isIncomplete } from './assessment-verify.js';

export class MatchError extends Error {
  constructor(readonly code: 'catalogue_mismatch') {
    super('Candidate and job assessments use different catalogue versions');
    this.name = 'MatchError';
  }
}

type Requirement = MatchResult['requirements'][number];

export function matchAssessments(
  candidate: CandidateAssessment,
  job: JobAssessment,
  overrides: ReadonlyMap<string, number> = new Map(),
): MatchResult {
  if (
    candidate.catalogue.id !== job.catalogue.id ||
    candidate.catalogue.version !== job.catalogue.version
  ) {
    throw new MatchError('catalogue_mismatch');
  }
  const skills = new Map(candidate.skills.map((s) => [s.skillId, s]));

  const requirements: Requirement[] = job.requirements.map((r) => {
    const override = overrides.get(r.skillId);
    const priority = override ?? r.suggestedPriority;
    const skill = skills.get(r.skillId);
    const base = {
      skillId: r.skillId,
      requiredLevel: r.requiredLevel,
      priority,
      prioritySource: override === undefined ? ('suggested' as const) : ('override' as const),
      referenceStatus: r.referenceStatus,
      candidateLevel: skill?.level ?? null,
      confidence: skill?.confidence ?? null,
      evidence: skill?.evidence ?? [],
    };
    if (!skill) return { ...base, verdict: 'not_demonstrated', credit: 0 };
    if (skill.level >= r.requiredLevel) return { ...base, verdict: 'met', credit: 1 };
    if (skill.level === r.requiredLevel - 1) return { ...base, verdict: 'partly_met', credit: 0.5 };
    return { ...base, verdict: 'below_required', credit: 0 };
  });

  const common = {
    subject: candidate.subject,
    jobKey: job.jobKey,
    catalogue: job.catalogue,
    requirements,
    eligibilityConstraints: job.eligibilityConstraints.map((c) => c.summary),
  };
  if (!job.inScope) return { ...common, status: 'unscored', reason: 'out_of_scope' };

  const total = requirements.reduce((sum, r) => sum + r.priority, 0);
  if (total === 0) return { ...common, status: 'unscored', reason: 'zero_priority' };

  const earned = requirements.reduce((sum, r) => sum + r.priority * r.credit, 0);
  const covered = requirements.reduce(
    (sum, r) => sum + (r.candidateLevel === null ? 0 : r.priority),
    0,
  );
  return {
    ...common,
    status: 'scored',
    compatibility: (100 * earned) / total,
    evidenceCoverage: (100 * covered) / total,
    // Research notes or a paraphrase are not the full posting, so requirements may be missing.
    provisional:
      candidate.status === 'partial' ||
      isIncomplete(candidate.coverage) ||
      job.textSource !== 'full_description',
  };
}
