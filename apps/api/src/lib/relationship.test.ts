import { describe, expect, it } from 'vitest';
import { canAnswer, NO_RELATIONSHIP, relationshipStage, stageFor } from './relationship.js';

const r = (patch: Partial<typeof NO_RELATIONSHIP>) => ({ ...NO_RELATIONSHIP, ...patch });

describe('relationshipStage', () => {
  it('opens nothing until both sides answer', () => {
    expect(relationshipStage(NO_RELATIONSHIP)).toBe('answering');
    expect(stageFor(r({ candidateAnswer: 'yes' }), 'candidate')).toBe('waiting');
    expect(stageFor(r({ candidateAnswer: 'yes' }), 'employer')).toBe('needs_response');
  });

  it('goes to Interview on two Yes and to Discussion on any Maybe', () => {
    expect(relationshipStage(r({ candidateAnswer: 'yes', employerAnswer: 'yes' }))).toBe(
      'interview',
    );
    const maybe = r({ candidateAnswer: 'maybe', employerAnswer: 'yes' });
    expect(relationshipStage(maybe)).toBe('discussion');
    expect(relationshipStage({ ...maybe, candidateConfirmed: true })).toBe('discussion');
    expect(
      relationshipStage({ ...maybe, candidateConfirmed: true, employerConfirmed: true }),
    ).toBe('interview');
  });

  it('closes on No and names who declined', () => {
    const declined = r({ candidateAnswer: 'yes', employerAnswer: 'no' });
    expect(stageFor(declined, 'employer')).toBe('you_declined');
    expect(stageFor(declined, 'candidate')).toBe('they_declined');
    // A withdrawn offer still reads as declined by the employer.
    expect(relationshipStage({ ...declined, offerStatus: 'withdrawn' })).toBe(
      'declined_by_employer',
    );
  });

  it('follows the offer once shared, and an accepted offer is final', () => {
    const both = r({ candidateAnswer: 'yes', employerAnswer: 'yes' });
    expect(relationshipStage({ ...both, offerStatus: 'draft' })).toBe('interview');
    expect(relationshipStage({ ...both, offerStatus: 'shared' })).toBe('offer_shared');
    expect(relationshipStage({ ...both, offerStatus: 'declined' })).toBe('offer_declined');
    expect(relationshipStage({ ...both, offerStatus: 'accepted' })).toBe('offer_accepted');
  });
});

describe('canAnswer', () => {
  it('allows unset to anything and Yes or Maybe only to No', () => {
    expect(canAnswer(NO_RELATIONSHIP, 'candidate', 'maybe')).toBe(true);
    const maybe = r({ candidateAnswer: 'maybe' });
    expect(canAnswer(maybe, 'candidate', 'yes')).toBe(false);
    expect(canAnswer(maybe, 'candidate', 'no')).toBe(true);
    expect(canAnswer(r({ candidateAnswer: 'no' }), 'employer', 'yes')).toBe(false);
  });

  it('refuses changes once the relationship is complete or closed', () => {
    const accepted = r({ candidateAnswer: 'yes', employerAnswer: 'yes', offerStatus: 'accepted' });
    expect(canAnswer(accepted, 'employer', 'no')).toBe(false);
    const shared = { ...accepted, offerStatus: 'shared' as const };
    expect(canAnswer(shared, 'employer', 'no')).toBe(true);
  });
});
