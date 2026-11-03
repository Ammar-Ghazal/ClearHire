// Groups one current candidate assessment by selected repository for display. Pure. Each repository
// shows only its own findings and evidence; a skill assessed from several repositories is labelled
// candidate-wide, and states that are not current never show stored findings.
import {
  evidenceUrl,
  SKILL_CATALOGUE,
  type CandidateAssessment,
  type EvidenceRef,
  type Freshness,
  type RepositoryBreakdown,
  type RepositoryFlag,
} from '@clearhire/shared';
import type { InputManifest } from '../db/schema.js';
import { fullName, type SelectedRepo } from './demo-prepare.js';

const SKILL_NAMES = new Map<string, string>(SKILL_CATALOGUE.skills.map((s) => [s.id, s.name]));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export { evidenceUrl };

const link = (ref: EvidenceRef) => ({
  path: ref.path,
  startLine: ref.startLine,
  endLine: ref.endLine,
  commitSha: ref.commitSha,
  attribution: ref.attribution,
  url: evidenceUrl(ref),
});

export interface BreakdownInput {
  /** The active selection, in order, with its GitHub ids and reassessment hints. */
  repositories: (SelectedRepo & { repoId?: number | null; flags?: RepositoryFlag[] })[];
  /** What the current assessment graded; null when none is current. */
  manifest: InputManifest | null;
  freshness: Freshness;
  /** Only a current assessment; never one for older inputs. */
  assessment: CandidateAssessment | null;
}

export function buildRepositoryBreakdown(input: BreakdownInput): RepositoryBreakdown[] {
  const { assessment } = input;
  return input.repositories.map((sel) => {
    const name = fullName(sel);
    const entry = input.manifest?.repos.find((r) => same(r.repo, name));
    const base: RepositoryBreakdown = {
      repo: name,
      repoId: sel.repoId ?? null,
      flags: sel.flags ?? [],
      url: `https://github.com/${name}`,
      pinnedSha: sel.pinnedSha,
      commitSha: entry?.commitSha ?? null,
      state: 'not_analyzed',
      reason: null,
      functionality: [],
      quality: [],
      limitations: [],
      contribution: null,
      skills: [],
      duplicates: [],
      coverage: { sampled: false, omittedRanges: 0, attributionGaps: [], limitations: [] },
    };
    switch (input.freshness.state) {
      case 'pending':
        return { ...base, state: 'pending' };
      case 'failed':
        return { ...base, state: 'failed', reason: input.freshness.errorCode };
      case 'outdated':
        return { ...base, state: 'outdated' };
      case 'current':
        break;
      default:
        return base;
    }
    if (!assessment || !entry) return base;
    // Some batches are graded: their findings show, and the reason says the rest is pending.
    const partly = entry.unavailable === 'partially_processed';
    if (entry.unavailable && !partly) {
      return { ...base, state: 'unavailable', reason: entry.unavailable };
    }
    if (partly) base.reason = entry.unavailable;
    if (assessment.status === 'no_attributed_evidence') {
      return { ...base, state: 'no_attributed_evidence' };
    }

    const own = (refs: EvidenceRef[]) => refs.filter((r) => same(r.repo, name)).map(link);
    const finding = assessment.repositories.find((f) => same(f.repo, name));
    const skills = assessment.skills.flatMap((s) => {
      const evidence = own(s.evidence);
      if (evidence.length === 0) return [];
      const repos = new Set(s.evidence.map((r) => r.repo.toLowerCase()));
      return [
        {
          skillId: s.skillId,
          name: SKILL_NAMES.get(s.skillId) ?? s.skillId,
          level: s.level,
          confidence: s.confidence,
          rationale: s.rationale,
          levelScope: repos.size > 1 ? ('candidate_wide' as const) : ('repository' as const),
          attributionLimitations: s.attributionLimitations,
          evidence,
        },
      ];
    });
    const { coverage } = assessment;
    return {
      ...base,
      state: finding || skills.length > 0 ? 'analyzed' : 'not_described',
      functionality: (finding?.functionality ?? []).map((c) => ({
        summary: c.summary,
        evidence: own(c.refs),
      })),
      quality: (finding?.qualityObservations ?? []).map((q) => ({
        kind: q.kind,
        observation: q.observation,
        evidence: own(q.refs),
      })),
      limitations: finding?.limitations ?? [],
      contribution: finding?.contribution
        ? { summary: finding.contribution.summary, evidence: own(finding.contribution.refs) }
        : null,
      skills,
      duplicates: coverage.duplicates
        .filter((d) => same(d.repo, name))
        .map((d) => ({ path: d.path, duplicateOf: d.duplicateOf })),
      coverage: {
        sampled: coverage.evidence === 'sampled',
        omittedRanges: coverage.omissions.filter((o) => same(o.repo, name)).length,
        attributionGaps: coverage.attributionGaps
          .filter((g) => same(g.repo, name))
          .map((g) => ({ reason: g.reason, commitSha: g.commitSha, path: g.path })),
        limitations: coverage.limitations
          .filter((l) => same(l.repo, name))
          .map((l) => l.limitation),
      },
    };
  });
}
