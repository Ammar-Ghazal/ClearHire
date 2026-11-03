// One derivation of a demo relationship's stage, used by every read and checked by every write.
// Pure: the routes load the relationship and offer, then ask what stage they are in.
import type { Answer, DemoSide, RelationshipStage } from '@clearhire/shared';

export type OfferStatus = 'draft' | 'shared' | 'accepted' | 'declined' | 'withdrawn';

export interface RelationshipFacts {
  candidateAnswer: Answer | null;
  employerAnswer: Answer | null;
  candidateConfirmed: boolean;
  employerConfirmed: boolean;
  offerStatus: OfferStatus | null;
}

/** Viewer-independent stage. */
export type Stage =
  | 'answering'
  | 'discussion'
  | 'interview'
  | 'offer_shared'
  | 'offer_accepted'
  | 'offer_declined'
  | 'declined_by_candidate'
  | 'declined_by_employer';

export const NO_RELATIONSHIP: RelationshipFacts = {
  candidateAnswer: null,
  employerAnswer: null,
  candidateConfirmed: false,
  employerConfirmed: false,
  offerStatus: null,
};

export function relationshipStage(r: RelationshipFacts): Stage {
  // An accepted offer completes the relationship, so no later answer can reopen or close it.
  if (r.offerStatus === 'accepted') return 'offer_accepted';
  if (r.candidateAnswer === 'no') return 'declined_by_candidate';
  if (r.employerAnswer === 'no') return 'declined_by_employer';
  if (r.offerStatus === 'declined') return 'offer_declined';
  if (r.offerStatus === 'shared') return 'offer_shared';
  if (r.candidateAnswer === null || r.employerAnswer === null) return 'answering';
  if (r.candidateAnswer === 'yes' && r.employerAnswer === 'yes') return 'interview';
  return r.candidateConfirmed && r.employerConfirmed ? 'interview' : 'discussion';
}

export const OPEN_STAGES: readonly Stage[] = ['answering', 'discussion', 'interview', 'offer_shared'];
export const MESSAGE_STAGES: readonly Stage[] = ['discussion', 'interview', 'offer_shared'];

const answerOf = (r: RelationshipFacts, side: DemoSide) =>
  side === 'candidate' ? r.candidateAnswer : r.employerAnswer;

export function stageFor(r: RelationshipFacts, side: DemoSide): RelationshipStage {
  const stage = relationshipStage(r);
  switch (stage) {
    case 'answering':
      return answerOf(r, side) === null ? 'needs_response' : 'waiting';
    case 'declined_by_candidate':
      return side === 'candidate' ? 'you_declined' : 'they_declined';
    case 'declined_by_employer':
      return side === 'employer' ? 'you_declined' : 'they_declined';
    default:
      return stage;
  }
}

/** Unset can become any answer; Yes or Maybe can only become No; No is permanent. */
export function canAnswer(r: RelationshipFacts, side: DemoSide, next: Answer): boolean {
  if (!OPEN_STAGES.includes(relationshipStage(r))) return false;
  const current = answerOf(r, side);
  return current === null || (current !== 'no' && next === 'no');
}
