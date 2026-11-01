import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIMITS, IngestError, ingestRepo } from './ingest.js';

const TOKEN = 'ghu_secret_token';
const target = { owner: 'octo', repo: 'demo' };

interface FakeFile {
  path: string;
  content?: Buffer;
  type?: string;
  mode?: string;
}

function httpError(status: number, headers: Record<string, string> = {}) {
  return Object.assign(new Error(`HttpError ${TOKEN}`), { status, response: { headers } });
}

/** A fake Octokit serving one commit. Blob SHAs are derived from the path. */
function fakeOctokit(files: FakeFile[], opts: { truncated?: boolean } = {}) {
  const shaOf = (path: string) => `sha-${path}`;
  const blobs = new Map(files.map((f) => [shaOf(f.path), f.content ?? Buffer.from(`// ${f.path}\n`)]));
  const tree = files.map((f) => ({
    path: f.path,
    type: f.type ?? 'blob',
    mode: f.mode ?? '100644',
    sha: shaOf(f.path),
    size: f.type && f.type !== 'blob' ? undefined : blobs.get(shaOf(f.path))!.length,
  }));

  const rest = {
    repos: {
      get: vi.fn(async () => ({ data: { default_branch: 'main' } })),
      getCommit: vi.fn(async (_: { ref: string }) => ({
        data: { sha: 'commit-1', commit: { tree: { sha: 'tree-1' } } },
      })),
    },
    git: {
      getTree: vi.fn(async () => ({ data: { tree, truncated: opts.truncated ?? false } })),
      getBlob: vi.fn(async ({ file_sha }: { file_sha: string; request?: { signal: AbortSignal } }) => ({
        data: { sha: file_sha, encoding: 'base64', content: blobs.get(file_sha)!.toString('base64') },
      })),
    },
  };
  return { octokit: { rest } as unknown as Octokit, rest };
}

async function ingestError(promise: Promise<unknown>): Promise<IngestError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(IngestError);
  expect((err as Error).message).not.toContain(TOKEN);
  return err as IngestError;
}

describe('ingestRepo', () => {
  it('pins the default branch commit and fetches only kept regular files', async () => {
    const { octokit, rest } = fakeOctokit([
      { path: 'src/z.ts' },
      { path: 'src/a.ts', content: Buffer.from('export const a = 1;\n') },
      { path: 'src', type: 'tree', mode: '040000' },
      { path: 'node_modules/x/index.js' },
      { path: 'pnpm-lock.yaml' },
      { path: 'link', mode: '120000' },
      { path: 'libs/sub', type: 'commit', mode: '160000' },
    ]);

    const snap = await ingestRepo(octokit, target);

    expect(rest.repos.getCommit).toHaveBeenCalledWith(expect.objectContaining({ ref: 'main' }));
    expect(snap.commitSha).toBe('commit-1');
    expect(rest.git.getTree).toHaveBeenCalledWith(expect.objectContaining({ tree_sha: 'tree-1' }));
    expect(rest.git.getBlob.mock.calls.map(([a]) => a.file_sha).sort()).toEqual([
      'sha-src/a.ts',
      'sha-src/z.ts',
    ]);
    expect(snap.files).toEqual([
      { path: 'src/a.ts', sha: 'sha-src/a.ts', content: 'export const a = 1;\n' },
      { path: 'src/z.ts', sha: 'sha-src/z.ts', content: '// src/z.ts\n' },
    ]);
    expect(snap.skipped).toEqual([
      { path: 'libs/sub', reason: 'submodule' },
      { path: 'link', reason: 'symlink' },
      { path: 'node_modules/x/index.js', reason: 'dependency' },
      { path: 'pnpm-lock.yaml', reason: 'lockfile' },
    ]);
  });

  it('uses an explicit ref without looking up the default branch', async () => {
    const { octokit, rest } = fakeOctokit([{ path: 'a.ts' }]);
    await ingestRepo(octokit, { ...target, ref: 'v1.2.0' });
    expect(rest.repos.get).not.toHaveBeenCalled();
    expect(rest.repos.getCommit).toHaveBeenCalledWith(expect.objectContaining({ ref: 'v1.2.0' }));
  });

  it('records non-UTF-8 and NUL-containing blobs as not_text', async () => {
    const { octokit } = fakeOctokit([
      { path: 'bad.txt', content: Buffer.from([0xff, 0xfe, 0x41]) },
      { path: 'nul.txt', content: Buffer.from('a\0b') },
      { path: 'ok.txt', content: Buffer.from('héllo') },
    ]);
    const snap = await ingestRepo(octokit, target);
    expect(snap.files.map((f) => f.path)).toEqual(['ok.txt']);
    expect(snap.skipped).toEqual([
      { path: 'bad.txt', reason: 'not_text' },
      { path: 'nul.txt', reason: 'not_text' },
    ]);
  });

  it('preserves a leading UTF-8 byte-order mark in source content', async () => {
    const content = '\uFEFFexport const value = 1;\n';
    const { octokit } = fakeOctokit([{ path: 'a.ts', content: Buffer.from(content) }]);
    expect((await ingestRepo(octokit, target)).files).toEqual([{ path: 'a.ts', sha: 'sha-a.ts', content }]);
  });

  it('rejects too many files or bytes before fetching any blob', async () => {
    const { octokit, rest } = fakeOctokit([{ path: 'a.ts' }, { path: 'b.ts' }]);
    expect(
      (await ingestError(ingestRepo(octokit, target, { ...DEFAULT_LIMITS, maxFiles: 1 }))).code,
    ).toBe('too_many_files');
    expect(
      (await ingestError(ingestRepo(octokit, target, { ...DEFAULT_LIMITS, maxTotalBytes: 5 }))).code,
    ).toBe('too_large');
    expect(rest.git.getBlob).not.toHaveBeenCalled();
  });

  it('times out and aborts the in-flight request', async () => {
    const { octokit, rest } = fakeOctokit([{ path: 'a.ts' }]);
    let seen: AbortSignal | undefined;
    rest.git.getBlob.mockImplementation(
      ({ request }: { file_sha: string; request?: { signal: AbortSignal } }) =>
        new Promise((_, reject) => {
          seen = request!.signal;
          seen.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const err = await ingestError(ingestRepo(octokit, target, { ...DEFAULT_LIMITS, timeoutMs: 20 }));
    expect(err.code).toBe('timeout');
    expect(seen?.aborted).toBe(true);
  });

  it('rejects a truncated tree', async () => {
    const { octokit } = fakeOctokit([{ path: 'a.ts' }], { truncated: true });
    expect((await ingestError(ingestRepo(octokit, target))).code).toBe('tree_truncated');
  });

  it.each([
    ['sha', { sha: 'sha-other.ts' }],
    ['size', { content: Buffer.from('longer content').toString('base64') }],
    ['encoding', { encoding: 'utf-8' }],
  ])('rejects a blob whose %s does not match its tree entry', async (_, override) => {
    const { octokit, rest } = fakeOctokit([{ path: 'a.ts' }, { path: 'other.ts' }]);
    rest.git.getBlob.mockImplementationOnce(async ({ file_sha }: { file_sha: string }) => ({
      data: {
        sha: file_sha,
        encoding: 'base64',
        content: Buffer.from('// a.ts\n').toString('base64'),
        ...override,
      },
    }));
    expect((await ingestError(ingestRepo(octokit, target))).code).toBe('inconsistent_data');
  });

  it.each([
    ['repos.get', httpError(404), 'not_found'],
    ['getCommit', httpError(409), 'empty_repository'],
    ['getCommit', httpError(403, { 'x-ratelimit-remaining': '0' }), 'rate_limited'],
    ['getBlob', httpError(429, { 'retry-after': '30' }), 'rate_limited'],
    ['getBlob', httpError(429), 'rate_limited'],
    ['getCommit', httpError(403), 'forbidden'],
    ['getTree', httpError(401), 'forbidden'],
    ['getBlob', httpError(503), 'upstream_error'],
    ['getBlob', new TypeError('fetch failed'), 'upstream_error'],
  ] as const)('maps a %s failure to %s', async (method, error, code) => {
    const { octokit, rest } = fakeOctokit([{ path: 'a.ts' }]);
    const fn = {
      'repos.get': rest.repos.get,
      getCommit: rest.repos.getCommit,
      getTree: rest.git.getTree,
      getBlob: rest.git.getBlob,
    }[method] as ReturnType<typeof vi.fn>;
    fn.mockRejectedValueOnce(error);
    const err = await ingestError(ingestRepo(octokit, target));
    expect(err.code).toBe(code);
  });
});
