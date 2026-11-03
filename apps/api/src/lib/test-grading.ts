// Test helpers only: grade a prepared fixture through the per-repository path, with Muse mocked.
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { repositorySelections } from '../db/schema.js';
import { analyzeRepositoryBatch, combineCandidate, type RunOptions } from './assessments.js';
import type { PreparedCandidate, PreparedRepo } from './candidate-evidence.js';
import { sha256Hex } from './packets.js';
import { saveSelection } from './repository-selection.js';

/** A stable GitHub-like id for a fixture repository name. */
export const fixtureRepoId = (fullName: string) =>
  Number.parseInt(sha256Hex(fullName.toLowerCase()).slice(0, 8), 16);

/** Answers Meta's token counter with a fixed small count, and passes every other call on. */
export function withCounts(fetchMock: typeof fetch, tokens = 1000): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) =>
    String(url).endsWith('/responses/input_tokens')
      ? new Response(JSON.stringify({ input_tokens: tokens }))
      : fetchMock(url, init)) as typeof fetch;
}

/** Selects the fixture's repositories, grades each as one batch, then combines the markers. */
export async function gradeFixture(prepared: PreparedCandidate, options: RunOptions) {
  const repos = prepared.repos.filter((r): r is PreparedRepo => !('unavailable' in r));
  const name = (r: PreparedRepo) => `${r.owner}/${r.repo}`;
  await saveSelection(
    prepared.subject,
    repos.map((r) => ({ id: fixtureRepoId(name(r)), fullName: name(r), pushedAt: null })),
    'demo_default',
  );
  for (const r of repos) {
    const repoId = fixtureRepoId(name(r));
    await analyzeRepositoryBatch(
      {
        prepared: { ...prepared, repos: [r] },
        repoId,
        part: 'batch:0/1:fixture',
        core: new Set(r.snapshot.files.map((f) => f.path)),
        processed: new Set(),
        attribution: 'complete',
        automatic: false,
        fresh: true,
      },
      options,
    );
    await db
      .update(repositorySelections)
      .set({ assessedCommit: r.snapshot.commitSha, assessedAt: new Date(), assessedSince: new Date(0) })
      .where(
        and(
          eq(repositorySelections.subjectKind, prepared.subject.kind),
          eq(repositorySelections.subjectKey, prepared.subject.key),
          eq(repositorySelections.repoId, repoId),
        ),
      );
  }
  return combineCandidate(prepared.subject, prepared.resume?.text ?? null, options);
}
