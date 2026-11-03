// Splits a candidate's evidence across requests when it cannot fit one, and consolidates the
// verified results. Pure: no model calls. Every file is sent; nothing is truncated or dropped.
import type { CandidateAssessment } from '@clearhire/shared';
import type { EvidenceLayout } from './candidate-evidence.js';

/**
 * Packs files into requests of at most `budget` tokens. Whole repositories come first; a repository
 * too large for one request is split by its files in path order, so directories stay together, and
 * each file brings its paired tests and imported files when they fit. A repository's header and
 * dependencies repeat in every request that holds its files. With `primary`, only those files are
 * packed for their own sake; any other file is sent only as a related file's context.
 */
export function packParts(
  layout: EvidenceLayout,
  cost: (text: string) => number,
  budget: number,
  primary?: ReadonlySet<string>,
): Set<string>[] {
  const isPrimary = (k: string) => !primary || primary.has(k);
  const repoOf = new Map<string, number>();
  const fileCost = new Map<string, number>();
  const relatedOf = new Map(layout.repos.flatMap((r) => r.files.map((f) => [f.key, f.related])));
  layout.repos.forEach((repo, i) => {
    for (const f of repo.files) {
      repoOf.set(f.key, i);
      fileCost.set(f.key, cost(f.text));
    }
  });
  const headerCost = layout.repos.map((r) => cost(r.header));

  const parts: Set<string>[] = [];
  const sent = new Set<string>();
  let current = new Set<string>();
  let reposIn = new Set<number>();
  let used = 0;
  const costOf = (keys: string[]) => {
    const added = new Set<number>();
    let total = 0;
    for (const k of new Set(keys)) {
      if (current.has(k)) continue;
      total += fileCost.get(k)!;
      const repo = repoOf.get(k)!;
      if (!reposIn.has(repo)) added.add(repo);
    }
    for (const repo of added) total += headerCost[repo]!;
    return total;
  };
  const add = (keys: string[]) => {
    used += costOf(keys);
    for (const k of keys) {
      current.add(k);
      sent.add(k);
      reposIn.add(repoOf.get(k)!);
    }
  };
  const close = () => {
    if (current.size > 0) parts.push(current);
    current = new Set();
    reposIn = new Set();
    used = 0;
  };

  layout.repos.forEach((repo, i) => {
    const all = repo.files.map((f) => f.key).filter((k) => !sent.has(k) && isPrimary(k));
    if (all.length === 0) return;
    // A whole repository brings its non-primary files along only as context.
    const whole = primary
      ? [...new Set(all.flatMap((k) => [k, ...(relatedOf.get(k) ?? [])]))]
      : all;
    if (used + costOf(whole) <= budget) return add(whole);
    const alone = headerCost[i]! + whole.reduce((sum, k) => sum + fileCost.get(k)!, 0);
    if (alone <= budget) {
      close();
      return add(whole);
    }
    for (const f of repo.files) {
      if (sent.has(f.key) || !isPrimary(f.key)) continue;
      const withContext = [...new Set([f.key, ...f.related])];
      if (used + costOf(withContext) <= budget) {
        add(withContext);
        continue;
      }
      // A group that fits a fresh request goes there whole rather than losing its context.
      const fresh = headerCost[i]! + withContext.reduce((sum, k) => sum + fileCost.get(k)!, 0);
      if (fresh <= budget) {
        close();
        add(withContext);
        continue;
      }
      if (used + costOf([f.key]) > budget) close();
      add([f.key]);
    }
  });
  close();
  return parts;
}

type Repository = CandidateAssessment['repositories'][number];
type Skill = CandidateAssessment['skills'][number];

const union = <T>(a: T[], b: T[]) => [...new Set([...a, ...b])];

/**
 * Consolidates assessments verified against their own request's evidence. Repository claims are
 * combined; each skill keeps the highest level any request supports, the catalogue's own rule, with
 * the evidence of every request that supports that level. Status follows `coverage`.
 */
export function mergeAssessments(
  parts: CandidateAssessment[],
  coverage: CandidateAssessment['coverage'],
  status: CandidateAssessment['status'],
): CandidateAssessment {
  const repositories = new Map<string, Repository>();
  const skills = new Map<string, Skill>();
  for (const part of parts) {
    for (const r of part.repositories) {
      const seen = repositories.get(r.repo);
      if (!seen) {
        repositories.set(r.repo, structuredClone(r));
        continue;
      }
      seen.functionality.push(...r.functionality);
      seen.qualityObservations.push(...r.qualityObservations);
      seen.limitations = union(seen.limitations, r.limitations);
      seen.contribution =
        seen.contribution && r.contribution
          ? {
              summary: `${seen.contribution.summary} ${r.contribution.summary}`,
              refs: [...seen.contribution.refs, ...r.contribution.refs],
            }
          : (seen.contribution ?? r.contribution);
    }
    for (const s of part.skills) {
      const seen = skills.get(s.skillId);
      if (!seen || s.level > seen.level) {
        skills.set(s.skillId, structuredClone(s));
      } else if (s.level === seen.level) {
        const refs = new Set(seen.evidence.map((e) => e.ref));
        seen.evidence.push(...s.evidence.filter((e) => !refs.has(e.ref)));
        seen.supportingTags = union(seen.supportingTags, s.supportingTags);
        seen.attributionLimitations = union(
          seen.attributionLimitations,
          s.attributionLimitations,
        ).sort();
      }
    }
  }
  return {
    ...parts[0]!,
    status,
    coverage,
    repositories: [...repositories.values()],
    skills: [...skills.values()],
    unsupportedSkills: parts.flatMap((p) => p.unsupportedSkills),
  };
}
