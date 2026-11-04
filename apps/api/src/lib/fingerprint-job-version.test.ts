import { describe, expect, it, vi } from 'vitest';

// A change to job grading logic outside the request body must give every posting a new key.
vi.mock('./assessment-verify.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./assessment-verify.js')>();
  return { ...actual, JOB_GRADING_VERSION: actual.JOB_GRADING_VERSION + 1 };
});

const { jobFingerprint } = await import('./assessments.js');

describe('job key versions', () => {
  it('change when JOB_GRADING_VERSION changes', () => {
    const posting = {
      jobKey: 'golden-job',
      employerId: 'acme',
      title: 'Engineer',
      text: 'Write unit tests',
      textSource: 'full_description' as const,
    };
    // The key recorded with the current versions (see GOLDEN in assessments.test.ts).
    expect(jobFingerprint(posting, { model: 'muse-spark-1.3-contributor' }).cacheKey).not.toBe(
      '51895e714216ff840900eed1c972cf3717c8ef126fad1f364f5798ff94b6faa6',
    );
  });
});
