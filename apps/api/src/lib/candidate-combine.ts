// Builds a candidate's combined markers from saved per-repository results. Pure: no model calls,
// no database. Each part keeps its own provenance; only the active selection is combined.
import { SKILL_CATALOGUE, type CandidateAssessment, type EvidenceRef } from '@clearhire/shared';
import { isIncomplete } from './assessment-verify.js';
import { mergeAssessments } from './candidate-parts.js';

type Coverage = CandidateAssessment['coverage'];
type Skill = CandidateAssessment['skills'][number];

const lower = (s: string) => s.toLowerCase();

/** Refs are only unique within one request, so each part's refs carry their row id. */
export function prefixRefs(a: CandidateAssessment, prefix: string): CandidateAssessment {
  const fix = (r: EvidenceRef): EvidenceRef => ({ ...r, ref: `${prefix}:${r.ref}` });
  return {
    ...a,
    repositories: a.repositories.map((r) => ({
      ...r,
      functionality: r.functionality.map((f) => ({ ...f, refs: f.refs.map(fix) })),
      qualityObservations: r.qualityObservations.map((q) => ({ ...q, refs: q.refs.map(fix) })),
      contribution: r.contribution && { ...r.contribution, refs: r.contribution.refs.map(fix) },
    })),
    skills: a.skills.map((s) => ({ ...s, evidence: s.evidence.map(fix) })),
  };
}

const uniqueBy = <T>(items: T[], key: (t: T) => string) => [
  ...new Map(items.map((i) => [key(i), i])).values(),
];

/** Everything every part could not show, plus repositories with no usable result yet. */
export function unionCoverage(
  parts: Coverage[],
  unavailable: Coverage['unavailableRepos'],
): Coverage {
  const omissions = parts.flatMap((c) => c.omissions);
  const sampled = parts.some((c) => c.evidence === 'sampled') || omissions.length > 0;
  return {
    evidence: sampled ? 'sampled' : 'complete',
    unavailableRepos: uniqueBy(
      [...parts.flatMap((c) => c.unavailableRepos), ...unavailable],
      (u) => `${lower(u.repo)}\n${u.reason}`,
    ),
    omissions,
    duplicates: parts.flatMap((c) => c.duplicates),
    attributionGaps: parts.flatMap((c) => c.attributionGaps),
    limitations: uniqueBy(
      parts.flatMap((c) => c.limitations),
      (l) => `${lower(l.repo)}\n${l.limitation}`,
    ),
  };
}

/** One disputed marker's verdict for one repository, applied after that repository's parts. */
export interface Overlay {
  repo: string;
  skillId: string;
  outcome: 'level' | 'removed' | 'inconclusive';
  /** The re-examined marker when the outcome is `level`. */
  skill: Skill | null;
}

/**
 * Replaces each overlay's skill in its repository's parts: a level replaces it, a supported removal
 * drops it, an inconclusive result changes nothing. Other skills keep their own parts untouched.
 */
export function applyOverlays(
  parts: { repo: string; assessment: CandidateAssessment }[],
  overlays: Overlay[],
): CandidateAssessment[] {
  const out = parts.map((p) => ({ repo: lower(p.repo), assessment: p.assessment }));
  for (const o of overlays) {
    if (o.outcome === 'inconclusive') continue;
    const repo = lower(o.repo);
    for (const p of out) {
      if (p.repo !== repo) continue;
      p.assessment = {
        ...p.assessment,
        skills: p.assessment.skills.filter((s) => s.skillId !== o.skillId),
      };
    }
    const first = out.find((p) => p.repo === repo);
    if (o.outcome === 'level' && o.skill && first) {
      out.push({
        repo,
        assessment: { ...first.assessment, repositories: [], skills: [o.skill], unsupportedSkills: [] },
      });
    }
  }
  return out.map((p) => p.assessment);
}

/**
 * The combined assessment: skills merge by highest supported level (the catalogue's rule), and
 * coverage is the union of every part's limits. Nothing found at all is `no_attributed_evidence`.
 */
export function combineParts(
  parts: CandidateAssessment[],
  unavailable: Coverage['unavailableRepos'],
  meta: Pick<CandidateAssessment, 'subject' | 'model'>,
): CandidateAssessment {
  const coverage = unionCoverage(
    parts.map((p) => p.coverage),
    unavailable,
  );
  const found = parts.some((p) => p.skills.length > 0 || p.repositories.length > 0);
  if (!found) {
    return {
      kind: 'candidate',
      subject: meta.subject,
      model: meta.model,
      catalogue: { id: SKILL_CATALOGUE.id, version: SKILL_CATALOGUE.version },
      status: 'no_attributed_evidence',
      verification: 'location_verified_not_competency',
      coverage,
      repositories: [],
      skills: [],
      unsupportedSkills: [],
    };
  }
  const merged = mergeAssessments(
    parts.filter((p) => p.skills.length > 0 || p.repositories.length > 0),
    coverage,
    isIncomplete(coverage) ? 'partial' : 'complete',
  );
  return { ...merged, subject: meta.subject, model: meta.model };
}

/**
 * The parts of an older combined result that still hold honestly for the selected repositories in
 * `usable` (active, never assessed on their own) that the old run fetched: one part per repository
 * with its own findings, coverage and single-repository skills, so a reassessment of one
 * repository touches only that repository. A skill whose evidence spans several repositories
 * cannot be split: it holds, in a separate group part, only while all of them are usable and none
 * of them re-examined it (`overlaid`, `repo\nskillId`); otherwise it is dropped and its other
 * repositories are reported as split, so they are graded on their own. Coverage stays as recorded.
 */
export function legacyView(
  legacy: CandidateAssessment,
  manifest: { repo: string; commitSha: string | null; unavailable: string | null }[],
  usable: ReadonlySet<string>,
  overlaid: ReadonlySet<string> = new Set(),
): {
  parts: { repo: string; assessment: CandidateAssessment }[];
  covered: Set<string>;
  split: Set<string>;
} {
  const reposOf = (s: Skill) => [...new Set(s.evidence.map((e) => lower(e.repo)))];
  // Only repositories the old run actually fetched and graded.
  const graded = new Set(
    manifest.filter((m) => m.commitSha !== null && m.unavailable === null).map((m) => lower(m.repo)),
  );
  const covered = new Set([...usable].map(lower).filter((r) => graded.has(r)));
  const split = new Set<string>();
  const single = new Map<string, Skill[]>();
  const spanning: Skill[] = [];
  for (const s of legacy.skills) {
    const repos = reposOf(s);
    const reexamined = repos.filter((r) => overlaid.has(`${r}\n${s.skillId}`));
    if (!repos.every((r) => covered.has(r)) || (repos.length > 1 && reexamined.length > 0)) {
      for (const r of repos) if (covered.has(r) && !reexamined.includes(r)) split.add(r);
    } else if (repos.length === 1) {
      single.set(repos[0]!, [...(single.get(repos[0]!) ?? []), s]);
    } else {
      spanning.push(s);
    }
  }
  const c = legacy.coverage;
  const only = (repo: string) => (x: { repo: string }) => lower(x.repo) === repo;
  const base = { ...legacy, unsupportedSkills: [] };
  const parts = [...covered].sort().map((repo) => ({
    repo,
    assessment: {
      ...base,
      repositories: legacy.repositories.filter(only(repo)),
      skills: single.get(repo) ?? [],
      coverage: {
        evidence: c.evidence,
        unavailableRepos: c.unavailableRepos.filter(only(repo)),
        omissions: c.omissions.filter(only(repo)),
        duplicates: c.duplicates.filter(only(repo)),
        attributionGaps: c.attributionGaps.filter(only(repo)),
        limitations: c.limitations.filter(only(repo)),
      },
    },
  }));
  // No repository name: a reassessment of one repository never edits a cross-repository level.
  if (spanning.length > 0) {
    const none = { unavailableRepos: [], omissions: [], duplicates: [], attributionGaps: [] };
    const coverage = { ...c, ...none, limitations: [] };
    parts.push({ repo: '', assessment: { ...base, repositories: [], skills: spanning, coverage } });
  }
  return { parts, covered, split };
}
