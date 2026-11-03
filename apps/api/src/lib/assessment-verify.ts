// Checks model references against stored evidence and renders them from stored data. This verifies
// where evidence is, not whether the model's competency judgment is right. Pure and deterministic.
import {
  SKILL_CATALOGUE,
  type CandidateAssessment,
  type EvidenceRef,
  type JobAssessment,
} from '@clearhire/shared';
import type { CandidateEvidence, EvidenceItem } from './candidate-evidence.js';
import {
  jobLines,
  MuseError,
  type CandidateOutput,
  type JobOutput,
  type MuseModel,
  type ReassessmentOutput,
} from './muse.js';

/** Recorded with each result; raw model output is not stored, so a change needs a regrade. */
export const VERIFIER_VERSION = 1;

const CATALOGUE = { id: SKILL_CATALOGUE.id, version: SKILL_CATALOGUE.version };

function assertUniqueSkills(ids: string[]): void {
  if (new Set(ids).size !== ids.length) {
    throw new MuseError('duplicate_skill_ids', 'Model output repeated a skill ID');
  }
}

function renderRef(item: EvidenceItem, note: string | null): EvidenceRef {
  return {
    ref: item.ref,
    repo: item.repo,
    commitSha: item.commitSha,
    path: item.path,
    startLine: item.startLine,
    endLine: item.endLine,
    sha256: item.sha256,
    attribution: item.attribution,
    contributions: item.contributions.map((c) => ({ ...c })),
    alsoIn: item.alsoIn.map((o) => ({ ...o })),
    note,
  };
}

/** Sampled evidence, unavailable repositories or attribution gaps make an assessment partial. */
export const isIncomplete = (coverage: CandidateAssessment['coverage']) =>
  coverage.evidence === 'sampled' ||
  coverage.unavailableRepos.length > 0 ||
  coverage.attributionGaps.length > 0;

export function verifyCandidate(
  output: CandidateOutput,
  evidence: CandidateEvidence,
  meta: { subject: CandidateAssessment['subject']; model: MuseModel },
): CandidateAssessment {
  assertUniqueSkills(output.skills.map((s) => s.skill_id));
  const items = new Map(evidence.items.map((i) => [i.ref, i]));
  const repoName = new Map(
    evidence.repos.flatMap((r) => [
      [r.ref, r.repo],
      [r.repo, r.repo],
    ]),
  );
  const inRepo = (item: EvidenceItem, repo: string) =>
    item.repo === repo || item.alsoIn.some((d) => d.repo === repo);

  /** All-or-nothing: a claim with any unverifiable reference is not kept. */
  const resolve = (refs: string[], ok: (item: EvidenceItem) => boolean): EvidenceRef[] | null => {
    if (refs.length === 0) return null;
    const resolved = refs
      .map((r) => items.get(r))
      .filter((i): i is EvidenceItem => i !== undefined && ok(i));
    return resolved.length === refs.length ? resolved.map((i) => renderRef(i, null)) : null;
  };

  const repositories: CandidateAssessment['repositories'] = [];
  for (const r of output.repositories) {
    const repo = repoName.get(r.repo);
    if (repo === undefined) continue;
    const any = (i: EvidenceItem) => inRepo(i, repo);
    // Only this repository's own history counts: an identical copy elsewhere transfers nothing.
    const attributed = (i: EvidenceItem) =>
      i.kind === 'attributed' &&
      i.contributions.some((c) => c.repo === repo && c.authorship !== 'undetermined');
    const contributionRefs = resolve(r.contribution.refs, attributed);
    repositories.push({
      repo,
      functionality: r.functionality.flatMap((f) => {
        const refs = resolve(f.refs, any);
        return refs ? [{ summary: f.summary, refs }] : [];
      }),
      qualityObservations: r.quality_observations.flatMap((q) => {
        const refs = resolve(q.refs, any);
        return refs ? [{ kind: q.kind, observation: q.observation, refs }] : [];
      }),
      limitations: r.limitations,
      contribution: contributionRefs
        ? { summary: r.contribution.summary, refs: contributionRefs }
        : null,
    });
  }

  const skills: CandidateAssessment['skills'] = [];
  const unsupportedSkills: CandidateAssessment['unsupportedSkills'] = [];
  for (const s of output.skills) {
    const invalid = s.evidence_refs.filter((ref) => items.get(ref)?.kind !== 'attributed');
    if (invalid.length > 0 || s.evidence_refs.length === 0) {
      unsupportedSkills.push({ skillId: s.skill_id, level: s.level, invalidRefs: invalid });
      continue;
    }
    const cited = s.evidence_refs.map((ref) => items.get(ref)!);
    const limitations = new Set<
      CandidateAssessment['skills'][number]['attributionLimitations'][number]
    >();
    for (const item of cited) {
      if (item.attribution === 'shared') limitations.add('shared_authorship');
      if (item.attribution === 'provisional' || item.contributions.some((c) => c.provisional)) {
        limitations.add('provisional_landing');
      }
      if (item.contributions.some((c) => c.aiCoauthorDeclared))
        limitations.add('ai_coauthor_declared');
    }
    if (evidence.coverage.evidence === 'sampled') limitations.add('sampled_evidence');
    skills.push({
      skillId: s.skill_id,
      level: s.level,
      confidence: s.confidence,
      rationale: s.justification,
      supportingTags: s.supporting_tags,
      evidence: s.evidence_refs.map((ref) => renderRef(items.get(ref)!, null)),
      attributionLimitations: [...limitations].sort(),
    });
  }

  const { coverage } = evidence;
  return {
    kind: 'candidate',
    subject: meta.subject,
    model: meta.model,
    catalogue: CATALOGUE,
    status: isIncomplete(coverage) ? 'partial' : 'complete',
    verification: 'location_verified_not_competency',
    coverage,
    repositories,
    skills,
    unsupportedSkills,
  };
}

/**
 * A reassessment's outcome for one disputed skill. `level` needs the skill itself to verify.
 * `removed` needs an explicit `not_demonstrated` conclusion with a rationale, refs that all resolve,
 * and those refs covering every file the marker previously cited, all of which were sent. Anything
 * else (missing or invalid output, unresolved refs, incomplete evidence) is `inconclusive`.
 */
export function verifyReassessment(
  output: ReassessmentOutput,
  evidence: CandidateEvidence,
  meta: { subject: CandidateAssessment['subject']; model: MuseModel },
  dispute: { skillId: string; priorPaths: string[] },
): {
  assessment: CandidateAssessment;
  outcome: 'level' | 'removed' | 'inconclusive';
  rationale: string;
} {
  const verified = verifyCandidate(
    { ...output, skills: output.skills.filter((s) => s.skill_id === dispute.skillId) },
    evidence,
    meta,
  );
  const skill = verified.skills.find((s) => s.skillId === dispute.skillId) ?? null;
  const { conclusion } = output;
  const items = new Map(evidence.items.map((i) => [i.ref, i]));
  const sent = new Set(evidence.items.map((i) => i.path));
  const cited = new Set(conclusion.refs.map((r) => items.get(r)?.path));
  let outcome: 'level' | 'removed' | 'inconclusive' = 'inconclusive';
  if (conclusion.kind === 'level' && skill) outcome = 'level';
  else if (
    conclusion.kind === 'not_demonstrated' &&
    !skill &&
    conclusion.rationale.trim() !== '' &&
    conclusion.refs.length > 0 &&
    conclusion.refs.every((r) => items.has(r)) &&
    dispute.priorPaths.length > 0 &&
    dispute.priorPaths.every((p) => sent.has(p) && cited.has(p))
  ) {
    outcome = 'removed';
  }
  return {
    assessment: { ...verified, skills: outcome === 'level' ? [skill!] : [] },
    outcome,
    rationale: conclusion.rationale,
  };
}

const QUOTE_MIN_CHARS = 30;

/**
 * Results are stored without repository code, but model prose can quote it. Any evidence line of
 * at least 30 characters that appears verbatim in a free-text field is replaced before storage.
 */
export function scrubQuotedSource(
  assessment: CandidateAssessment,
  evidence: Pick<CandidateEvidence, 'items'>,
): CandidateAssessment {
  const lines = [
    ...new Set(
      evidence.items.flatMap((i) =>
        i.text
          .split(/\r\n|\n|\r/)
          .map((l) => l.trim())
          .filter((l) => l.length >= QUOTE_MIN_CHARS),
      ),
    ),
  ];
  const scrub = (text: string) =>
    lines.reduce((t, l) => (t.includes(l) ? t.replaceAll(l, '[source excerpt removed]') : t), text);
  return {
    ...assessment,
    repositories: assessment.repositories.map((r) => ({
      ...r,
      functionality: r.functionality.map((f) => ({ ...f, summary: scrub(f.summary) })),
      qualityObservations: r.qualityObservations.map((q) => ({
        ...q,
        observation: scrub(q.observation),
      })),
      limitations: r.limitations.map(scrub),
      contribution: r.contribution && { ...r.contribution, summary: scrub(r.contribution.summary) },
    })),
    skills: assessment.skills.map((s) => ({
      ...s,
      rationale: scrub(s.rationale),
      supportingTags: s.supportingTags.map(scrub),
    })),
  };
}

export interface JobInput {
  jobKey: string;
  employerId: string | null;
  title: string;
  text: string;
  textSource: 'full_description' | 'source_summary' | 'fixture_summary';
}

export function verifyJob(output: JobOutput, job: JobInput, model: MuseModel): JobAssessment {
  assertUniqueSkills(output.requirements.map((r) => r.skill_id));
  const lines = jobLines(job.text);
  const lineOf = (ref: string) => {
    const n = /^j(\d+)$/.exec(ref)?.[1];
    return n === undefined ? undefined : lines[Number(n) - 1];
  };
  const resolve = (refs: string[]) => {
    const resolved = refs.flatMap((ref) => {
      const text = lineOf(ref);
      return text === undefined ? [] : [{ ref, text }];
    });
    return refs.length > 0 && resolved.length === refs.length ? resolved : null;
  };

  // A failed source reference flags the requirement for review; it never removes it from scoring.
  const requirements: JobAssessment['requirements'] = output.requirements.map((r) => {
    const invalidRefs = r.refs.filter((ref) => lineOf(ref) === undefined);
    return {
      skillId: r.skill_id,
      requiredLevel: r.required_level,
      suggestedPriority: r.suggested_priority,
      refs: r.refs.flatMap((ref) => {
        const text = lineOf(ref);
        return text === undefined ? [] : [{ ref, text }];
      }),
      referenceStatus: invalidRefs.length > 0 || r.refs.length === 0 ? 'needs_review' : 'verified',
      invalidRefs,
    };
  });

  return {
    kind: 'job',
    jobKey: job.jobKey,
    employerId: job.employerId,
    title: job.title,
    model,
    catalogue: CATALOGUE,
    textSource: job.textSource,
    inScope: output.in_scope,
    outOfScopeReason: output.in_scope
      ? null
      : (output.out_of_scope_reason ?? 'Not a software role'),
    requirements,
    eligibilityConstraints: output.eligibility_constraints.flatMap((c) => {
      const refs = resolve(c.refs);
      return refs ? [{ summary: c.summary, refs }] : [];
    }),
    supportingTags: output.supporting_tags,
  };
}
