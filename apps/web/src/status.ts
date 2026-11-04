// One vocabulary for relationship stages and score states, shared by every page.
import type {
  Answer,
  Arrangement,
  DemoJob,
  Freshness,
  Offer,
  RelationshipStage,
  RepositoryBreakdown,
  RepositoryFlag,
  Score,
} from '@clearhire/shared';

export type StageGroup = 'needs_response' | 'in_progress' | 'completed' | 'closed';

export const STAGE_FILTERS: { value: StageGroup | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'needs_response', label: 'Needs your response' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'closed', label: 'Closed' },
];

const amber = 'bg-amber-100 text-amber-900';
const slate = 'bg-slate-100 text-slate-700';
const sky = 'bg-sky-100 text-sky-900';
const emerald = 'bg-emerald-100 text-emerald-900';

export const STAGES: Record<RelationshipStage, { group: StageGroup; chip: string }> = {
  needs_response: { group: 'needs_response', chip: amber },
  waiting: { group: 'in_progress', chip: slate },
  discussion: { group: 'in_progress', chip: sky },
  interview: { group: 'in_progress', chip: sky },
  offer_shared: { group: 'in_progress', chip: sky },
  offer_accepted: { group: 'completed', chip: emerald },
  offer_declined: { group: 'closed', chip: slate },
  you_declined: { group: 'closed', chip: slate },
  they_declined: { group: 'closed', chip: slate },
};

/** `other` names the counterpart for "Declined by …". */
export function stageLabel(stage: RelationshipStage, other: string): string {
  switch (stage) {
    case 'needs_response':
      return 'Needs your response';
    case 'waiting':
      return 'Waiting for them';
    case 'discussion':
      return 'Discussion';
    case 'interview':
      return 'Interview';
    case 'offer_shared':
      return 'Offer shared';
    case 'offer_accepted':
      return 'Offer accepted';
    case 'offer_declined':
      return 'Offer declined';
    case 'you_declined':
      return 'You declined';
    case 'they_declined':
      return `Declined by ${other}`;
  }
}

export const OPEN_STAGES: RelationshipStage[] = [
  'needs_response',
  'waiting',
  'discussion',
  'interview',
  'offer_shared',
];
export const MESSAGE_STAGES: RelationshipStage[] = ['discussion', 'interview', 'offer_shared'];

/** Labels for every score state that is not a score; never shown as 0%. */
export const SCORE_LABELS: Record<Exclude<Score['state'], 'scored'>, string> = {
  updating: 'Analysis in progress',
  failed: 'Analysis failed',
  outdated: 'Analysis outdated',
  not_analyzed: 'Not analyzed yet',
  no_attributed_code: 'No attributed code',
  zero_priority: 'Every priority is 0',
  profile_incomplete: 'Profile incomplete',
};

export const TEXT_SOURCES: Record<DemoJob['textSource'], string> = {
  full_description: 'Full posting text',
  source_summary: 'Summary of the original posting',
  fixture_summary: 'Abbreviated research notes, not the full posting',
};

const FRESHNESS_LABELS: Partial<Record<Freshness['state'], string>> = {
  pending: 'Analysis in progress',
  failed: 'Analysis failed',
  outdated: 'Analysis outdated',
  not_applicable: 'Out of scope: not analyzed',
};

/** Analysis state of one subject, in the same words as the score states. */
export function freshnessLabel(f: Freshness): string {
  if (f.state === 'current') {
    return f.assessmentStatus === 'no_attributed_evidence' ? 'No attributed code' : 'Current analysis';
  }
  return FRESHNESS_LABELS[f.state] ?? 'Not analyzed yet';
}

export const REPO_STATES: Record<RepositoryBreakdown['state'], string> = {
  analyzed: 'Analyzed',
  not_described: 'Analyzed; nothing reported for this repository',
  no_attributed_evidence: 'No attributed code',
  unavailable: 'Could not be fetched',
  pending: 'Analysis updating',
  failed: 'Analysis failed',
  outdated: 'Analysis outdated',
  not_analyzed: 'Not analyzed yet',
};

/** Hints that a repository may deserve a regrade or dispute; none starts any work. */
export const REPO_FLAGS: Record<RepositoryFlag, string> = {
  changed_since_assessed: 'New commits since it was graded',
  resume_changed: 'Graded with an earlier résumé',
  attribution_limited: 'Sole authorship not verified',
  legacy_split: 'Waiting to be graded on its own',
};

export const ANSWERS: Record<Answer, string> = { yes: 'Yes', maybe: 'Maybe', no: 'No' };

export const ARRANGEMENTS: Record<Arrangement, string> = {
  on_site: 'On-site',
  hybrid: 'Hybrid',
  remote: 'Remote',
};

export const OFFER_STATUS: Record<Offer['status'], string> = {
  draft: 'Draft',
  shared: 'Offer shared',
  accepted: 'Offer accepted',
  declined: 'Offer declined',
  withdrawn: 'Offer withdrawn',
};

export const percent = (value: number) => `${Math.round(value)}%`;

export const cad = (value: number) =>
  new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 })
    .format(value);

export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
