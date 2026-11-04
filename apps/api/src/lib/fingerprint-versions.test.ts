import { describe, expect, it, vi } from 'vitest';

// A prompt or attribution change must give every seeker input a new key, so older results read as
// outdated; posting keys depend on neither, since a job never reads repositories.
vi.mock('./muse.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./muse.js')>();
  return { ...actual, PROMPT_VERSION: actual.PROMPT_VERSION + 1 };
});
vi.mock('./attribution.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./attribution.js')>();
  return { ...actual, ATTRIBUTION_VERSION: actual.ATTRIBUTION_VERSION + 1 };
});

const { candidateKey, combinedKey, jobFingerprint, repositoryRowKey } = await import('./assessments.js');

const MODEL = 'muse-spark-1.3-contributor' as const;
const subject = { kind: 'demo' as const, key: 'golden-evidence' };
// The keys recorded with the current versions (see GOLDEN in assessments.test.ts).
const GOLDEN = {
  candidate: '90828a9f79bb05831f3188ad7ba5c9e364e9f86bad38dae276a93a69aaee1b71',
  job: '51895e714216ff840900eed1c972cf3717c8ef126fad1f364f5798ff94b6faa6',
};

describe('input key versions', () => {
  it('change seeker keys when an analysis-affecting version changes', () => {
    const { cacheKey } = candidateKey(
      subject,
      { repos: [{ owner: 'octo', repo: 'one' }], resumeText: null },
      { model: MODEL },
    );
    expect(cacheKey).not.toBe(GOLDEN.candidate);
  });

  it('leave posting keys alone', () => {
    const posting = {
      jobKey: 'golden-job',
      employerId: 'acme',
      title: 'Engineer',
      text: 'Write unit tests',
      textSource: 'full_description' as const,
    };
    expect(jobFingerprint(posting, { model: MODEL }).cacheKey).toBe(GOLDEN.job);
  });

  it('cover repository and combined keys too', async () => {
    const { cacheKeyOf, candidateVersions } = await import('./assessments.js');
    const v1 = { ...candidateVersions(), attribution: candidateVersions().attribution - 1 };
    const parts = { kind: 'repository', subject, model: MODEL, repoId: 1, commitSha: 'c', part: 'p' };
    expect(repositoryRowKey(subject, MODEL, 1, 'c', 'p')).not.toBe(cacheKeyOf(parts, v1));
    const combined = { kind: 'candidate', subject, model: MODEL, repoIds: [1] };
    expect(combinedKey(subject, MODEL, [1])).not.toBe(cacheKeyOf(combined, v1));
  });
});
