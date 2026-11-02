import { describe, expect, it, vi } from 'vitest';
import { fixtureCandidate, fixtureRepo, sourceLines } from './candidate-fixtures.js';

// A prompt change must give every input a new fingerprint, so older results read as outdated.
vi.mock('./muse.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./muse.js')>();
  return { ...actual, PROMPT_VERSION: actual.PROMPT_VERSION + 1 };
});

const { candidateFingerprint } = await import('./assessments.js');

describe('fingerprint versions', () => {
  it('change when an analysis-affecting version changes', () => {
    const prepared = fixtureCandidate(
      [
        fixtureRepo(
          'one',
          [{ path: 'src/a.ts', content: sourceLines(30) }],
          [{ sha: 'c1', path: 'src/a.ts', start: 1, end: 5 }],
        ),
      ],
      { subject: { kind: 'demo', key: 'golden-evidence' } },
    );
    const { cacheKey } = candidateFingerprint(prepared, { model: 'muse-spark-1.3-contributor' });
    // The key recorded with the current versions (see GOLDEN in assessments.test.ts).
    expect(cacheKey).not.toBe('ef9a60edb1418d4ee8f6e02b6382ae895ccd25aff478146a15684751767acc0d');
  });
});
