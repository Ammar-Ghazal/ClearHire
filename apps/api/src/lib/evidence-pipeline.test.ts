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
  };
  const responses = new Map<string, unknown>([
    ['/repos/cand/demo', { default_branch: 'main', fork: false, owner: { id: 101 } }],
    ['/repos/cand/demo/commits/main', commit],
    [`/repos/cand/demo/commits/${commitSha}`, commit],
    ['/repos/cand/demo/git/trees/tree', {
      truncated: false,
      tree: [{ path: 'src/add.ts', type: 'blob', mode: '100644', sha: blobSha, size: bytes.length }],
    }],
    [`/repos/cand/demo/git/blobs/${blobSha}`, {
      sha: blobSha, encoding: 'base64', content: bytes.toString('base64'),
    }],
  ]);
  const actor = (login: string, id: number, email: string) => ({
    name: 'Candidate', email, user: { databaseId: id, login },
  });
  const history = {
    repository: {
      isFork: false,
      owner: { databaseId: 101 },
      object: { oid: commitSha, tree: { oid: 'tree' }, history: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{
          oid: commitSha, message: 'Initial implementation', parents: { nodes: [] },
          author: actor('cand', 101, '101+cand@users.noreply.github.com'),
          committer: null,
          associatedPullRequests: { totalCount: 0, nodes: [] },
        }],
      } },
    },
  };
  const blame = { repository: { object: {
    f0: { ranges: [{ startingLine: 1, endingLine: 2, commit: { oid: commitSha } }] },
  } } };
  const graphqlQueries: { query: string; variables: Record<string, unknown> }[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).pathname;
    let body: unknown;
    if (path === '/graphql') {
      const sent = JSON.parse(String(init?.body)) as (typeof graphqlQueries)[number];
      graphqlQueries.push(sent);
      body = { data: sent.query.includes('history(') ? history : blame };
    } else if (responses.has(path)) {
      body = responses.get(path);
    } else {
      throw new Error(`Unexpected GitHub request: ${path}`);
    }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  });
  const octokit = new Octokit({ request: { fetch: fetchMock } });
  const snapshot = await ingestRepo(octokit, target);
  const packets = buildPackets(snapshot, target);
  const collected = await collectContributions(octokit, { ...target, commitSha }, candidate, [
    'src/add.ts',
  ]);
  const report = attributeContributions(collected, candidate, { snapshot, packets });

  expect(snapshot.commitSha).toBe(commitSha);
  expect(packets.chunks[0]!.text).not.toContain(token);
  expect(packets.chunks[0]!.redactions.length).toBeGreaterThan(0);
  expect(report.contributions).toHaveLength(1);
  expect(report.contributions[0]).toMatchObject({
    authorship: 'sole', provisional: false,
    ranges: [{ start: 1, end: 2, mapping: 'exact', analysis: 'snapshot_chunks',
      chunkIds: [packets.chunks[0]!.id] }],
  });
  expect(report.coverage.gaps).toEqual([]);

  // History and blame must be read at the pinned snapshot commit, not the moving default branch.
  expect(graphqlQueries.map((q) => [q.variables.oid, q.variables.p0])).toEqual([
    [commitSha, undefined],
    [commitSha, 'src/add.ts'],
  ]);
  expect(attributeContributions(collected, { ...candidate, githubUserId: 202, login: 'other' }, {
    snapshot, packets,
  }).contributions).toEqual([]);
});
