import { hasPendingWork, topMatches, type Score } from '@clearhire/shared';
import { describe, expect, it } from 'vitest';

// The shared helpers behind the Matches page's top-N list and its refresh condition.
const score = (state: Score['state'], compatibility: number | null = null, pending = false) => ({
  score: { state, compatibility, evidenceCoverage: compatibility, provisional: false, pending },
});
const scored = (compatibility: number, pending = false) => score('scored', compatibility, pending);

describe('topMatches', () => {
  it('ranks scored pairs by compatibility and leaves out every unscored pair', () => {
    const list = [
      scored(40),
      score('updating', null, true),
      scored(90),
      score('failed'),
      scored(65),
      score('profile_incomplete'),
    ];
    expect(topMatches(list, 5).map((m) => m.score.compatibility)).toEqual([90, 65, 40]);
  });

  it('shows N from 5 through 10, defaulting the bounds for anything outside', () => {
    const list = Array.from({ length: 14 }, (_, i) => scored(i));
    expect(topMatches(list, 5)).toHaveLength(5);
    expect(topMatches(list, 7).map((m) => m.score.compatibility)).toEqual([13, 12, 11, 10, 9, 8, 7]);
    expect(topMatches(list, 10)).toHaveLength(10);
    expect(topMatches(list, 2)).toHaveLength(5);
    expect(topMatches(list, 40)).toHaveLength(10);
    expect(topMatches(list.slice(0, 3), 10)).toHaveLength(3);
  });
});

describe('hasPendingWork', () => {
  it('is true while any pair waits on an analysis, even with nothing scored or displayed', () => {
    expect(hasPendingWork([score('updating', null, true), score('failed')])).toBe(true);
    // A regrade of an already scored pair, outside the displayed top N, still counts.
    const list = [...Array.from({ length: 6 }, () => scored(80)), scored(10, true)];
    expect(topMatches(list, 5).some((m) => m.score.pending)).toBe(false);
    expect(hasPendingWork(list)).toBe(true);
  });

  it('is false once nothing is queued or running, whatever else failed or is incomplete', () => {
    expect(hasPendingWork([score('failed'), score('profile_incomplete'), scored(50)])).toBe(false);
    expect(hasPendingWork([])).toBe(false);
  });
});
