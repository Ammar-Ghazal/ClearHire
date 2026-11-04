// Fetches a filtered, in-memory snapshot of a repo at one commit SHA. Reads bytes only: nothing from
// the repo is installed, written to disk or executed. Content cleanup happens in a later step.
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
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
    /** For `rate_limited`: when GitHub allows requests again (epoch ms). */
    readonly resetAt?: number,
  ) {
    super(message);
  }
}

interface HttpError {
  status?: number;
  response?: { headers?: Record<string, string | number | undefined>; data?: unknown };
}

/** GitHub documents no headers for some secondary-limit responses: wait at least a minute then. */
const SECONDARY_WAIT_MS = 60_000;

/**
 * When a quota response allows requests again, or null when the response is not quota-related.
 * A 403 is a quota response only with exhausted-quota headers, `retry-after`, or GitHub's
 * secondary-rate-limit message; any other 403 is a permission denial.
 * https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#rate-limit-errors
 */
export function quotaResetAt(err: unknown, now = Date.now()): number | null {
  const { status, response } = (err ?? {}) as HttpError;
  if (status !== 403 && status !== 429) return null;
  const headers = response?.headers ?? {};
  const retryAfter = Number(headers['retry-after']);
  if (headers['retry-after'] !== undefined && Number.isFinite(retryAfter)) {
    return now + retryAfter * 1000;
  }
  const reset = Number(headers['x-ratelimit-reset']);
  if (String(headers['x-ratelimit-remaining']) === '0') {
    return Number.isFinite(reset) ? Math.max(now, reset * 1000) : now + SECONDARY_WAIT_MS;
  }
  const message = (response?.data as { message?: unknown } | undefined)?.message;
  if (status === 429 || (typeof message === 'string' && /rate limit/i.test(message))) {
    return now + SECONDARY_WAIT_MS;
  }
  return null;
}

// Maps an Octokit failure to a typed error. Never copies the original message or response body.
export function toIngestError(err: unknown, step: string, signal: AbortSignal): IngestError {
  if (err instanceof IngestError) return err;
  if (signal.aborted) return new IngestError('timeout', `Timed out during ${step}`);

  const { status } = (err ?? {}) as HttpError;
  if (status === 404) return new IngestError('not_found', `GitHub returned 404 during ${step}`, status);
  if (status === 409 && step === 'getCommit') {
    return new IngestError('empty_repository', 'Repository has no commits', status);
  }
  const resetAt = quotaResetAt(err);
  if (resetAt !== null) {
    return new IngestError('rate_limited', `GitHub rate limit hit during ${step}`, status, resetAt);
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

async function step<T>(signal: AbortSignal, name: string, fn: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw new IngestError('timeout', `Timed out before ${name}`);
  try {
    return await fn();
  } catch (err) {
    throw toIngestError(err, name, signal);
  }
}

/** A commit pinned by SHA, with its filtered tree; no file content yet. */
export interface PinnedTree {
  commitSha: string;
  kept: TreeEntry[];
  skipped: RepoSnapshot['skipped'];
  /** GitHub's remaining core quota after the tree request: a hint only, workers share it. */
  quota: { remaining: number; resetAt: number } | null;
  /** Bytes of every blob at the commit, kept or not: about the size of its archive. */
  totalBytes: number;
}

/** Pins `ref` (default branch when omitted, or a commit SHA) and lists its filtered tree. */
export async function pinTree(
  octokit: Octokit,
  target: { owner: string; repo: string; ref?: string },
  limits: IngestLimits = DEFAULT_LIMITS,
  signal: AbortSignal = AbortSignal.timeout(limits.timeoutMs),
): Promise<PinnedTree> {
  const { owner, repo } = target;
  const request = { signal };
  let ref = target.ref;
  if (!ref) {
    const { data } = await step(signal, 'getRepo', () =>
      octokit.rest.repos.get({ owner, repo, request }),
    );
    ref = data.default_branch;
  }

  // Pin the commit; every later read is by SHA, so a moving branch can't mix two versions.
  const { data: commit } = await step(signal, 'getCommit', () =>
    octokit.rest.repos.getCommit({ owner, repo, ref, request }),
  );
  return listTree(
    octokit,
    target,
    { commitSha: commit.sha, treeSha: commit.commit.tree.sha },
    limits,
    signal,
  );
}

/**
 * The filtered recursive tree of a commit already pinned (by `pinTree`, or by GraphQL history
 * with `pinHistory`), in one REST request; a truncated listing is refused.
 */
export async function listTree(
  octokit: Octokit,
  target: { owner: string; repo: string },
  commit: { commitSha: string; treeSha: string },
  limits: IngestLimits = DEFAULT_LIMITS,
  signal: AbortSignal = AbortSignal.timeout(limits.timeoutMs),
): Promise<PinnedTree> {
  const { owner, repo } = target;
  const request = { signal };
  const { data: tree, headers } = await step(signal, 'getTree', () =>
    octokit.rest.git.getTree({
      owner,
      repo,
      tree_sha: commit.treeSha,
      recursive: 'true',
      request,
    }),
  );
  if (tree.truncated) throw new IngestError('tree_truncated', 'Repository tree is too large to list');

  const kept: TreeEntry[] = [];
  const skipped: RepoSnapshot['skipped'] = [];
  let totalBytes = 0;
  for (const entry of tree.tree as TreeEntry[]) {
    if (entry.type === 'blob') totalBytes += entry.size ?? 0;
    const result = filterEntry(entry, limits.maxFileBytes);
    if (result === null) kept.push(entry);
    else if (result !== 'ignore') skipped.push({ path: entry.path, reason: result });
  }
  const remaining = Number(headers?.['x-ratelimit-remaining']);
  const reset = Number(headers?.['x-ratelimit-reset']);
  const quota =
    Number.isFinite(remaining) && Number.isFinite(reset)
      ? { remaining, resetAt: reset * 1000 }
      : null;
  return { commitSha: commit.commitSha, kept, skipped, quota, totalBytes };
}

// ---- Archive ----

/** Largest repository (every blob at the commit) downloaded as one archive; bigger ones go per file. */
export const ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;

/** Kept files' bytes from one archive, by path. Held in memory only: nothing is written to disk. */
export type RepoArchive = Map<string, Buffer>;

/** Git's blob SHA-1, so an archived file is used only when it is byte-identical to the tree's blob. */
export const gitBlobSha = (bytes: Buffer) =>
  createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/**
 * The kept files of a pinned commit from one tarball request (1 quota point instead of one per
 * file). Null when the repository is too large or the archive fails for a non-quota reason: callers
 * then fetch file by file, as they do for any file the archive lacks or alters (export-ignore,
 * export-subst, eol conversion, LFS content).
 * https://docs.github.com/en/rest/repos/contents#download-a-repository-archive-tar
 */
export async function downloadArchive(
  octokit: Octokit,
  target: { owner: string; repo: string },
  tree: Pick<PinnedTree, 'commitSha' | 'kept' | 'totalBytes'>,
  signal: AbortSignal = AbortSignal.timeout(
    DEFAULT_LIMITS.timeoutMs + Math.ceil((tree.totalBytes ?? 0) / 1_048_576) * 1000,
  ),
): Promise<RepoArchive | null> {
  if (tree.kept.length === 0 || tree.totalBytes > ARCHIVE_MAX_BYTES) return null;
  let gzipped: Buffer;
  try {
    const { data } = await octokit.rest.repos.downloadTarballArchive({
      ...target,
      ref: tree.commitSha,
      request: { signal },
    });
    gzipped = Buffer.from(data as ArrayBuffer);
  } catch (err) {
    const typed = toIngestError(err, 'downloadTarballArchive', signal);
    if (typed.code === 'rate_limited') throw typed;
    return null;
  }
  try {
    const tar = gunzipSync(gzipped, { maxOutputLength: 2 * ARCHIVE_MAX_BYTES });
    return readTar(tar, new Set(tree.kept.map((e) => e.path)));
  } catch {
    return null;
  }
}

/** Regular files of an uncompressed tar whose path (top directory stripped) is in `wanted`. */
export function readTar(tar: Buffer, wanted: Set<string>): RepoArchive {
  const files: RepoArchive = new Map();
  let longPath: string | null = null;
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start: number, length: number) => {
      const raw = header.subarray(start, start + length);
      const end = raw.indexOf(0);
      return raw.subarray(0, end === -1 ? length : end).toString('utf8');
    };
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1) || '0';
    const body = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      longPath = paxPath(body) ?? longPath;
      continue;
    }
    if (type === 'L') {
      longPath = body.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    const prefix = field(345, 155);
    const name = longPath ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longPath = null;
    if (type !== '0') continue;
    const path = name.slice(name.indexOf('/') + 1);
    // A copy, so the whole archive buffer can be freed once read.
    if (wanted.has(path)) files.set(path, Buffer.from(body));
  }
  return files;
}

/** The `path` record of a pax extended header ("<length> path=<value>\n" records). */
function paxPath(body: Buffer): string | null {
  let path: string | null = null;
  for (let at = 0; at < body.length; ) {
    const space = body.indexOf(0x20, at);
    const length = parseInt(body.toString('utf8', at, space), 10);
    if (space === -1 || !(length > 0)) break;
    const record = body.toString('utf8', space + 1, at + length - 1);
    if (record.startsWith('path=')) path = record.slice('path='.length);
    at += length;
  }
  return path;
}

/**
 * Reads `entries` from `archive` when byte-identical to the tree, otherwise downloads them by blob
 * SHA, a few at a time; non-text files are reported as skipped.
 */
export async function fetchFiles(
  octokit: Octokit,
  target: { owner: string; repo: string },
  entries: TreeEntry[],
  signal: AbortSignal = AbortSignal.timeout(DEFAULT_LIMITS.timeoutMs),
  archive: RepoArchive | null = null,
): Promise<Pick<RepoSnapshot, 'files' | 'skipped'>> {
  const { owner, repo } = target;
  const request = { signal };
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const files: RepoSnapshot['files'] = [];
  const skipped: RepoSnapshot['skipped'] = [];
  async function download(entry: TreeEntry): Promise<Buffer> {
    const archived = archive?.get(entry.path);
    if (archived && gitBlobSha(archived) === entry.sha) return archived;
    const { data: blob } = await step(signal, 'getBlob', () =>
      octokit.rest.git.getBlob({ owner, repo, file_sha: entry.sha, request }),
    );
    const bytes = Buffer.from(blob.content, 'base64');
    if (blob.encoding !== 'base64' || blob.sha !== entry.sha || bytes.length !== entry.size) {
      throw new IngestError('inconsistent_data', `Blob for ${entry.path} does not match the tree`);
    }
    return bytes;
  }
  async function fetchBlob(entry: TreeEntry) {
    const bytes = await download(entry);

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
    while (next < entries.length) {
      try {
        await fetchBlob(entries[next++]!);
      } catch (err) {
        next = entries.length;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(BLOB_CONCURRENCY, entries.length) }, worker));
  return { files: files.sort(byPath), skipped: skipped.sort(byPath) };
}

const byPath = (a: { path: string }, b: { path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/** Whether `entries` exceed the file-count or byte limits of one download. */
export function overLimits(
  entries: TreeEntry[],
  limits: Pick<IngestLimits, 'maxFiles' | 'maxTotalBytes'> = DEFAULT_LIMITS,
): 'too_many_files' | 'too_large' | null {
  if (entries.length > limits.maxFiles) return 'too_many_files';
  const totalBytes = entries.reduce((sum, e) => sum + (e.size ?? 0), 0);
  return totalBytes > limits.maxTotalBytes ? 'too_large' : null;
}

/** Snapshot of `owner/repo` at `ref` (default branch when omitted). */
export async function ingestRepo(
  octokit: Octokit,
  target: { owner: string; repo: string; ref?: string },
  limits: IngestLimits = DEFAULT_LIMITS,
): Promise<RepoSnapshot> {
  const signal = AbortSignal.timeout(limits.timeoutMs);
  const pinned = await pinTree(octokit, target, limits, signal);
  // Check limits before downloading anything.
  const over = overLimits(pinned.kept, limits);
  if (over === 'too_many_files') {
    throw new IngestError('too_many_files', `Repository has more than ${limits.maxFiles} files to ingest`);
  }
  if (over === 'too_large') {
    throw new IngestError('too_large', `Repository has more than ${limits.maxTotalBytes} bytes to ingest`);
  }
  const archive = await downloadArchive(octokit, target, pinned);
  const fetched = await fetchFiles(octokit, target, pinned.kept, signal, archive);
  return {
    commitSha: pinned.commitSha,
    files: fetched.files,
    skipped: [...pinned.skipped, ...fetched.skipped].sort(byPath),
  };
}
