import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, IngestError } from './ingest.js';
import {
  assertGitHubAvailable,
  needsWork,
  noteQuota,
  partition,
  resetGitHubPause,
} from './repository-runs.js';

const entry = (i: number, size = 10) => ({
  path: `src/f${String(i).padStart(5, '0')}.ts`,
  mode: '100644',
  type: 'blob' as const,
  sha: `s${i}`,
  size,
});

describe('partition', () => {
  it('splits a large tree into path-order batches within the download limits', () => {
    const tree = Array.from({ length: 2_500 }, (_, i) => entry(2_499 - i));
    const batches = partition(tree);
    expect(batches.map((b) => b.length)).toEqual([1_000, 1_000, 500]);
    expect(batches.flat().map((e) => e.path)).toEqual(tree.map((e) => e.path).sort());
    const heavy = Array.from({ length: 300 }, (_, i) => entry(i, 200_000));
    for (const b of partition(heavy)) {
      expect(b.reduce((s, e) => s + (e.size ?? 0), 0)).toBeLessThanOrEqual(DEFAULT_LIMITS.maxTotalBytes);
    }
    expect(partition([])).toEqual([[]]);
  });
});

describe('needsWork', () => {
  const base = {
    subjectKind: 'demo' as const,
    subjectKey: 'k',
    repoId: 1,
    fullName: 'octo/one',
    position: 0,
    source: 'demo_default' as const,
    active: true,
    pushedAt: null,
    assessedCommit: null,
    assessedAt: null,
    assessedSince: null,
    legacyAssessmentId: null,
    progress: null,
    freshRequestedAt: null,
    lastError: null,
    githubFailures: 0,
    confirmedAt: new Date(),
  };

  it('grades new and unfinished repositories, never ones already assessed or covered', () => {
    expect(needsWork(base, 'automatic')).toBe(true);
    const progress = { commitSha: 'c', batches: ['d'], done: [], since: new Date(0).toISOString() };
    expect(needsWork({ ...base, assessedCommit: 'c', progress }, 'automatic')).toBe(true);
    expect(needsWork({ ...base, assessedCommit: 'c' }, 'automatic')).toBe(false);
    expect(needsWork({ ...base, legacyAssessmentId: 'x' }, 'explicit')).toBe(false);
    expect(needsWork({ ...base, active: false }, 'explicit')).toBe(false);
    // A requested regrade outlives the run that asked for it, even over saved or older results.
    const asked = { freshRequestedAt: new Date() };
    expect(needsWork({ ...base, assessedCommit: 'c', ...asked }, 'automatic')).toBe(true);
    expect(needsWork({ ...base, legacyAssessmentId: 'x', ...asked }, 'automatic')).toBe(true);
  });

  it('retries only a few transient GitHub failures automatically; the rest wait for a person', () => {
    expect(needsWork({ ...base, lastError: 'timeout', githubFailures: 1 }, 'automatic')).toBe(true);
    expect(needsWork({ ...base, lastError: 'timeout', githubFailures: 3 }, 'automatic')).toBe(false);
    for (const code of ['not_found', 'invalid_output', 'previous_failure', 'budget_exceeded']) {
      expect(needsWork({ ...base, lastError: code }, 'automatic')).toBe(false);
      expect(needsWork({ ...base, lastError: code }, 'explicit')).toBe(true);
    }
  });
});

describe('shared GitHub pause', () => {
  it('stops new GitHub work until the reset a quota response reported', () => {
    resetGitHubPause();
    noteQuota(new IngestError('rate_limited', 'q', 403, 5_000));
    noteQuota(new IngestError('forbidden', 'denied', 403));
    expect(() => assertGitHubAvailable(4_999)).toThrow(expect.objectContaining({ resetAt: 5_000 }));
    expect(() => assertGitHubAvailable(5_000)).not.toThrow();
    resetGitHubPause();
  });
});
