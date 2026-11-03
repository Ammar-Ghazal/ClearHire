import { describe, expect, it, vi } from 'vitest';

// A prompt change must give every input a new key, so older results read as outdated.
vi.mock('./muse.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./muse.js')>();
  return { ...actual, PROMPT_VERSION: actual.PROMPT_VERSION + 1 };
});

const { candidateKey } = await import('./assessments.js');

describe('input key versions', () => {
  it('change when an analysis-affecting version changes', () => {
    const { cacheKey } = candidateKey(
      { kind: 'demo', key: 'golden-evidence' },
      { repos: [{ owner: 'octo', repo: 'one' }], resumeText: null },
      { model: 'muse-spark-1.3-contributor' },
    );
    // The key recorded with the current versions (see GOLDEN in assessments.test.ts).
    expect(cacheKey).not.toBe('6b46d4130fea435fdcc26522deb6aec90f94b2f97df781663626f6b36c08791c');
  });
});
