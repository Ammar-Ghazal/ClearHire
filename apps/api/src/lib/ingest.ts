// Fetches a filtered, in-memory snapshot of a repo at one commit SHA. Reads bytes only: nothing from
// the repo is installed, written to disk or executed. Content cleanup happens in a later step.
import type { Octokit } from '@octokit/rest';
import { filterEntry, type SkipReason, type TreeEntry } from './ingest-filter.js';

export interface IngestLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  timeoutMs: number;
}

export const DEFAULT_LIMITS: IngestLimits = {
  maxFiles: 1_000,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  timeoutMs: 120_000,
};

export interface RepoSnapshot {
  commitSha: string;
  /** `sha` is the git blob SHA, so later steps can tell whether a file changed since a commit. */
  files: { path: string; sha: string; content: string }[];
  skipped: { path: string; reason: SkipReason }[];
}

export type IngestErrorCode =
  | 'not_found'
  | 'empty_repository'
  | 'rate_limited'
  | 'forbidden'
  | 'upstream_error'
  | 'timeout'
  | 'tree_truncated'
  | 'too_many_files'
  | 'too_large'
  | 'inconsistent_data';

export class IngestError extends Error {
  constructor(
    readonly code: IngestErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

interface HttpError {
  status?: number;
  response?: { headers?: Record<string, string | number | undefined> };
}

// Maps an Octokit failure to a typed error. Never copies the original message or response body.
export function toIngestError(err: unknown, step: string, signal: AbortSignal): IngestError {
  if (err instanceof IngestError) return err;
  if (signal.aborted) return new IngestError('timeout', `Timed out during ${step}`);

  const { status, response } = (err ?? {}) as HttpError;
  const headers = response?.headers ?? {};
  if (status === 404) return new IngestError('not_found', `GitHub returned 404 during ${step}`, status);
  if (status === 409 && step === 'getCommit') {
    return new IngestError('empty_repository', 'Repository has no commits', status);
  }
  if (
    status === 429 || (status === 403 &&
    (String(headers['x-ratelimit-remaining']) === '0' || headers['retry-after'] !== undefined))
  ) {
    return new IngestError('rate_limited', `GitHub rate limit hit during ${step}`, status);
  }
  if (status === 401 || status === 403) {
    return new IngestError('forbidden', `GitHub denied access during ${step}`, status);
  }
  return new IngestError('upstream_error', `GitHub request failed during ${step}`, status);
}

/**
 * Blob downloads in flight per repository. One at a time, recorded runs of 413-869-file repositories
 * hit the 120s timeout; the request rate itself is paced by the Octokit (see demoOctokit).
 */
export const BLOB_CONCURRENCY = 4;

/** Snapshot of `owner/repo` at `ref` (default branch when omitted). */
export async function ingestRepo(
  octokit: Octokit,
  target: { owner: string; repo: string; ref?: string },
  limits: IngestLimits = DEFAULT_LIMITS,
): Promise<RepoSnapshot> {
  const { owner, repo } = target;
  const signal = AbortSignal.timeout(limits.timeoutMs);
  const request = { signal };

  async function call<T>(step: string, fn: () => Promise<T>): Promise<T> {
    if (signal.aborted) throw new IngestError('timeout', `Timed out before ${step}`);
    try {
      return await fn();
    } catch (err) {
      throw toIngestError(err, step, signal);
    }
  }

  let ref = target.ref;
  if (!ref) {
    const { data } = await call('getRepo', () => octokit.rest.repos.get({ owner, repo, request }));
    ref = data.default_branch;
  }

  // Pin the commit; every later read is by SHA, so a moving branch can't mix two versions.
  const { data: commit } = await call('getCommit', () =>
    octokit.rest.repos.getCommit({ owner, repo, ref, request }),
  );
  const commitSha = commit.sha;

  const { data: tree } = await call('getTree', () =>
    octokit.rest.git.getTree({
      owner,
      repo,
      tree_sha: commit.commit.tree.sha,
      recursive: 'true',
      request,
    }),
  );
  if (tree.truncated) throw new IngestError('tree_truncated', 'Repository tree is too large to list');

  const kept: TreeEntry[] = [];
  const skipped: RepoSnapshot['skipped'] = [];
  for (const entry of tree.tree as TreeEntry[]) {
    const result = filterEntry(entry, limits.maxFileBytes);
    if (result === null) kept.push(entry);
    else if (result !== 'ignore') skipped.push({ path: entry.path, reason: result });
  }

  // Check limits before downloading anything.
  if (kept.length > limits.maxFiles) {
    throw new IngestError('too_many_files', `Repository has more than ${limits.maxFiles} files to ingest`);
  }
  const totalBytes = kept.reduce((sum, e) => sum + (e.size ?? 0), 0);
  if (totalBytes > limits.maxTotalBytes) {
    throw new IngestError('too_large', `Repository has more than ${limits.maxTotalBytes} bytes to ingest`);
  }

  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const files: RepoSnapshot['files'] = [];
  async function fetchBlob(entry: TreeEntry) {
    const { data: blob } = await call('getBlob', () =>
      octokit.rest.git.getBlob({ owner, repo, file_sha: entry.sha, request }),
    );
    const bytes = Buffer.from(blob.content, 'base64');
    if (blob.encoding !== 'base64' || blob.sha !== entry.sha || bytes.length !== entry.size) {
      throw new IngestError('inconsistent_data', `Blob for ${entry.path} does not match the tree`);
    }

    let content: string;
    try {
      content = decoder.decode(bytes);
    } catch {
      skipped.push({ path: entry.path, reason: 'not_text' });
      return;
    }
    if (content.includes('\0')) {
      skipped.push({ path: entry.path, reason: 'not_text' });
      return;
    }
    files.push({ path: entry.path, sha: entry.sha, content });
  }
  // A few blobs in flight; results are sorted below, so arrival order never matters.
  let next = 0;
  const worker = async () => {
    while (next < kept.length) {
      try {
        await fetchBlob(kept[next++]!);
      } catch (err) {
        next = kept.length;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(BLOB_CONCURRENCY, kept.length) }, worker));

  const byPath = (a: { path: string }, b: { path: string }) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  return { commitSha, files: files.sort(byPath), skipped: skipped.sort(byPath) };
}
