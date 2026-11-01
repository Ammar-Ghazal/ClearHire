import { createHash } from 'node:crypto';
import { Octokit } from '@octokit/rest';
import { expect, it, vi } from 'vitest';
import { attributeContributions } from './attribution.js';
import { collectContributions } from './contributions.js';
import { ingestRepo } from './ingest.js';
import { buildPackets } from './packets.js';

it('connects ingestion, cleanup and attribution through real Octokit response parsing', async () => {
  const candidate = { githubUserId: 101, login: 'cand', verifiedEmails: [] };
  const target = { owner: 'cand', repo: 'demo' };
  const token = `ghp_${'a'.repeat(36)}`;
  const content = `export const token = '${token}';\nexport const add = (a: number, b: number) => a + b;\n`;
  const bytes = Buffer.from(content);
  const blobSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const commitSha = 'a'.repeat(40);
  const commit = {
    sha: commitSha,
    parents: [],
    author: { id: 101, login: 'cand', type: 'User' },
    committer: null,
    commit: {
      message: 'Initial implementation',
      author: { name: 'Candidate', email: '101+cand@users.noreply.github.com' },
      committer: null,
      tree: { sha: 'tree' },
    },
    files: [{
      filename: 'src/add.ts', status: 'added', sha: blobSha, changes: 2,
      patch: `@@ -0,0 +1,2 @@\n+export const token = '${token}';\n+export const add = (a: number, b: number) => a + b;`,
    }],
  };
  const responses = new Map<string, unknown>([
    ['/repos/cand/demo', { default_branch: 'main', fork: false, owner: { id: 101 } }],
    ['/repos/cand/demo/commits/main', commit],
    [`/repos/cand/demo/commits/${commitSha}`, commit],
    ['/repos/cand/demo/commits', [commit]],
    [`/repos/cand/demo/commits/${commitSha}/pulls`, []],
    ['/repos/cand/demo/git/trees/tree', {
      truncated: false,
      tree: [{ path: 'src/add.ts', type: 'blob', mode: '100644', sha: blobSha, size: bytes.length }],
    }],
    [`/repos/cand/demo/git/blobs/${blobSha}`, {
      sha: blobSha, encoding: 'base64', content: bytes.toString('base64'),
    }],
  ]);
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const path = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).pathname;
    if (!responses.has(path)) throw new Error(`Unexpected GitHub request: ${path}`);
    return new Response(JSON.stringify(responses.get(path)), {
      headers: { 'content-type': 'application/json' },
    });
  });
  const octokit = new Octokit({ request: { fetch: fetchMock } });
  const snapshot = await ingestRepo(octokit, target);
  const packets = buildPackets(snapshot, target);
  const collected = await collectContributions(octokit, { ...target, commitSha }, candidate);
  const report = attributeContributions(collected, candidate, { snapshot, packets });

  expect(snapshot.commitSha).toBe(commitSha);
  expect(packets.chunks[0]!.text).not.toContain(token);
  expect(packets.chunks[0]!.redactions.length).toBeGreaterThan(0);
  expect(report.contributions).toHaveLength(1);
  expect(report.contributions[0]).toMatchObject({
    authorship: 'sole', provisional: false, patch: 'complete',
    ranges: [{ start: 1, end: 2, mapping: 'exact', analysis: 'snapshot_chunks',
      chunkIds: [packets.chunks[0]!.id] }],
  });
  expect(report.coverage.gaps).toEqual([]);

  // History must be listed from the pinned snapshot commit, not the moving default branch.
  const historyRequests = fetchMock.mock.calls
    .map(([input]) => new URL(typeof input === 'string' || input instanceof URL ? input : input.url))
    .filter((url) => url.pathname === '/repos/cand/demo/commits');
  expect(historyRequests.map((url) => url.searchParams.get('sha'))).toEqual([commitSha]);
  expect(attributeContributions(collected, { ...candidate, githubUserId: 202, login: 'other' }, {
    snapshot, packets,
  }).contributions).toEqual([]);
});
