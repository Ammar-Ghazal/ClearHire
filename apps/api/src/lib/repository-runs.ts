// Grades one selected repository at a pinned commit, resuming where an earlier run stopped. Code is
// downloaded one batch at a time, held only in memory and dropped after grading; only results and
// progress (commit, batch digests, which batches are done) are stored.
import type { Octokit } from '@octokit/rest';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { repositorySelections, type RepositoryProgress } from '../db/schema.js';
import {
  analyzeRepositoryBatch,
  processedPaths,
  saveNoEvidence,
  type RunOptions,
} from './assessments.js';
import {
  conclusivelyNoContributions,
  hasUnresolvedAuthors,
  type CandidateIdentity,
} from './attribution.js';
import type { DataUse, Omission, PreparedCandidate } from './candidate-evidence.js';
import { collectContributions, DEFAULT_COLLECT_LIMITS } from './contributions.js';
import type { TreeEntry } from './ingest-filter.js';
import { DEFAULT_LIMITS, fetchFiles, IngestError, overLimits, pinTree } from './ingest.js';
import { MuseError } from './muse.js';
import { contextPaths, sha256Hex } from './packets.js';

type Selection = typeof repositorySelections.$inferSelect;

/** GitHub failures retried automatically, a few times, before an explicit action is needed. */
export const GITHUB_TRANSIENT = new Set(['timeout', 'upstream_error']);
export const MAX_GITHUB_FAILURES = 3;

/** Context files sent with one batch of a repository too large for a single download. */
export const MAX_CONTEXT_FILES = 200;

// ---- Shared GitHub pause ----

let pausedUntil = 0;

/** Every worker shares the token's quota: after one quota response, none starts GitHub work. */
export function noteQuota(err: unknown): void {
  if (err instanceof IngestError && err.code === 'rate_limited' && err.resetAt) {
    pausedUntil = Math.max(pausedUntil, err.resetAt);
  }
}

export function assertGitHubAvailable(now = Date.now()): void {
  if (now < pausedUntil) {
    throw new IngestError('rate_limited', 'GitHub quota is exhausted until reset', 429, pausedUntil);
  }
}

/** Test seam: forget the shared pause. */
export function resetGitHubPause(): void {
  pausedUntil = 0;
}

// ---- Batches ----

/** Path-order batches within one download's file and byte limits; deterministic for a tree. */
export function partition(kept: TreeEntry[]): TreeEntry[][] {
  const sorted = [...kept].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const batches: TreeEntry[][] = [];
  let current: TreeEntry[] = [];
  for (const entry of sorted) {
    if (current.length > 0 && overLimits([...current, entry]) !== null) {
      batches.push(current);
      current = [];
    }
    current.push(entry);
  }
  if (current.length > 0 || batches.length === 0) batches.push(current);
  return batches;
}

/** Request starts are paced across every worker, so a download's time limit grows with its size. */
const downloadSignal = (files: number) => AbortSignal.timeout(DEFAULT_LIMITS.timeoutMs + files * 250);

const digestOf = (entries: TreeEntry[]) =>
  sha256Hex(entries.map((e) => `${e.path}\0${e.sha}`).join('\n')).slice(0, 16);

/**
 * Whether a selected repository still needs work. A GitHub quota wait records no failure, so it
 * resumes on its own; automatic runs also retry a few transient GitHub failures. Any other failure,
 * including a failed paid request, waits for an explicit regrade.
 */
export function needsWork(s: Selection, mode: 'automatic' | 'explicit'): boolean {
  if (!s.active) return false;
  if (s.lastError && mode === 'automatic') {
    if (!GITHUB_TRANSIENT.has(s.lastError) || s.githubFailures >= MAX_GITHUB_FAILURES) return false;
  }
  if (s.freshRequestedAt !== null) return true;
  if (s.legacyAssessmentId !== null) return false;
  return s.progress !== null || s.assessedCommit === null || s.lastError !== null;
}

/**
 * Records an explicit regrade of `repoIds` (all active ones when omitted) before any GitHub work,
 * so a quota wait or a crash never loses it; earlier failures no longer block it.
 */
export async function requestFresh(
  subject: { kind: 'demo' | 'user'; key: string },
  repoIds: number[] | undefined,
): Promise<void> {
  await db
    .update(repositorySelections)
    .set({ freshRequestedAt: new Date(), lastError: null, githubFailures: 0 })
    .where(
      and(
        eq(repositorySelections.subjectKind, subject.kind),
        eq(repositorySelections.subjectKey, subject.key),
        eq(repositorySelections.active, true),
        repoIds ? inArray(repositorySelections.repoId, repoIds) : undefined,
      ),
    );
}

const ofRow = (s: Selection) =>
  and(
    eq(repositorySelections.subjectKind, s.subjectKind),
    eq(repositorySelections.subjectKey, s.subjectKey),
    eq(repositorySelections.repoId, s.repoId),
  );

async function saveProgress(s: Selection, progress: RepositoryProgress | null, fresh = false) {
  // Fresh progress now carries the regrade (its `since`), so the request itself is done.
  await db
    .update(repositorySelections)
    .set({ progress, ...(fresh && { freshRequestedAt: null }) })
    .where(ofRow(s));
}

export interface RepositoryContext {
  subject: PreparedCandidate['subject'];
  identity: CandidateIdentity;
  resumeText: string | null;
  dataUse: DataUse;
}

/**
 * Brings one repository's grading up to date. Pins head (or resumes the pinned commit), collects
 * contributions first, and skips every download only when history conclusively holds nothing of
 * the candidate's. Otherwise each unfinished batch is downloaded with its context and graded; when
 * every batch is processed the commit becomes the assessed one, superseding any earlier commit.
 * Processing finishing does not mean the evidence is complete: limitations stay in the results.
 */
export async function processRepository(
  octokit: Octokit,
  ctx: RepositoryContext,
  selection: Selection,
  mode: { fresh: boolean; automatic: boolean; owned?: () => Promise<boolean> },
  options: RunOptions = {},
): Promise<void> {
  const [owner, repo] = selection.fullName.split('/') as [string, string];
  assertGitHubAvailable();
  let progress = mode.fresh ? null : selection.progress;
  const tree = await pinTree(octokit, { owner, repo, ...(progress && { ref: progress.commitSha }) });
  const batches = partition(tree.kept);
  const digests = batches.map(digestOf);
  if (!progress || progress.batches.join() !== digests.join()) {
    progress = {
      commitSha: tree.commitSha,
      batches: digests,
      done: [],
      since: (mode.fresh ? new Date() : new Date(0)).toISOString(),
    };
    await saveProgress(selection, progress, mode.fresh);
  }
  const commitSha = progress.commitSha;
  const fresh = progress.since !== new Date(0).toISOString();

  const collected = await collectContributions(octokit, { owner, repo, commitSha }, ctx.identity);
  const attribution: 'complete' | 'limited' =
    collected.gaps.length > 0 || hasUnresolvedAuthors(collected, ctx.identity) ? 'limited' : 'complete';
  const resume = ctx.resumeText === null ? null : { text: ctx.resumeText };
  const manifest = (paths: string[]) => ({
    repos: [{ repo: selection.fullName, commitSha, unavailable: null }],
    resumeSha256: ctx.resumeText === null ? null : sha256Hex(ctx.resumeText),
    paths,
    attribution,
  });

  if (conclusivelyNoContributions(collected, ctx.identity)) {
    await saveNoEvidence(
      {
        subject: ctx.subject,
        repoId: selection.repoId,
        commitSha,
        part: `contributions:none:${digests.join('.')}`,
        manifest: manifest([]),
        fresh,
      },
      options,
    );
    progress = { ...progress, done: batches.map((_, i) => i) };
  }

  const treePaths = tree.kept.map((e) => e.path);
  const entryOf = new Map(tree.kept.map((e) => [e.path, e]));
  for (const [i, batch] of batches.entries()) {
    if (progress.done.includes(i)) continue;
    assertGitHubAvailable();
    // A hint only: other workers share the quota, so a quota response can still arrive.
    const need = batch.length + MAX_CONTEXT_FILES + DEFAULT_COLLECT_LIMITS.maxRequests;
    if (tree.quota && tree.quota.remaining < need) {
      const { resetAt } = tree.quota;
      throw new IngestError('rate_limited', 'GitHub quota too low for this batch', 429, resetAt);
    }
    const part = `batch:${i}/${batches.length}:${digests[i]}`;
    const since = new Date(progress.since);
    const earlier = await processedPaths(ctx.subject, selection.repoId, commitSha, part, since, options);
    if (earlier.failed && mode.automatic) {
      throw new MuseError('previous_failure', 'A paid request for this batch failed; regrade it');
    }
    const core = await fetchFiles(octokit, { owner, repo }, batch, downloadSignal(batch.length));
    const omissions: Omission[] = [];
    let context: typeof core = { files: [], skipped: [] };
    if (batches.length > 1) {
      // Imports, paired tests and manifests outside this batch: context only, never citable.
      const wanted = contextPaths(core.files, treePaths).filter(
        (p) => !batch.some((e) => e.path === p),
      );
      const fetched = wanted.slice(0, MAX_CONTEXT_FILES).map((p) => entryOf.get(p)!);
      for (const p of wanted.slice(MAX_CONTEXT_FILES)) {
        const whole = { startLine: null, endLine: null };
        omissions.push({ repo: selection.fullName, path: p, reason: 'context_omitted', ...whole });
      }
      context = await fetchFiles(octokit, { owner, repo }, fetched, downloadSignal(fetched.length));
    }
    const prepared: PreparedCandidate = {
      subject: ctx.subject,
      identity: ctx.identity,
      repos: [
        {
          owner,
          repo,
          collectedFor: ctx.identity.githubUserId,
          snapshot: {
            commitSha,
            files: [...core.files, ...context.files].sort((a, b) => (a.path < b.path ? -1 : 1)),
            skipped: [...tree.skipped, ...core.skipped, ...context.skipped],
          },
          collected,
        },
      ],
      resume,
      dataUse: ctx.dataUse,
    };
    const done = await analyzeRepositoryBatch(
      {
        prepared,
        repoId: selection.repoId,
        part,
        core: new Set(batch.map((e) => e.path)),
        processed: earlier.paths,
        attribution,
        automatic: mode.automatic,
        fresh,
        ...(mode.owned && { owned: mode.owned }),
        omissions,
      },
      options,
    );
    if (batch.every((e) => done.has(e.path))) {
      progress = { ...progress, done: [...progress.done, i] };
      await saveProgress(selection, progress);
    }
  }

  if (progress.done.length === batches.length) {
    await db
      .update(repositorySelections)
      .set({
        assessedCommit: commitSha,
        assessedAt: new Date(),
        assessedSince: new Date(progress.since),
        progress: null,
        legacyAssessmentId: null,
        freshRequestedAt: null,
        lastError: null,
        githubFailures: 0,
      })
      .where(ofRow(selection));
  }
}

/** Records why a repository stopped, counting transient GitHub failures toward their limit. */
export async function recordFailure(s: Selection, code: string): Promise<void> {
  await db
    .update(repositorySelections)
    .set({
      lastError: code,
      githubFailures: GITHUB_TRANSIENT.has(code) ? s.githubFailures + 1 : s.githubFailures,
    })
    .where(ofRow(s));
}
