// Synthetic prepared candidates for tests: commits add exact line ranges to snapshot files.
import type { CandidateIdentity, CommitDetail, CommitSummary, PrLookup } from './attribution.js';
import type { PreparedCandidate, PreparedRepo } from './candidate-evidence.js';

export const CANDIDATE: CandidateIdentity = {
  githubUserId: 101,
  login: 'cand',
  verifiedEmails: [],
};
const ME = { id: 101, login: 'cand', type: 'User' };
const OTHER = { id: 202, login: 'other', type: 'User' };

export const sourceLines = (count: number, prefix = 'v') =>
  Array.from({ length: count }, (_, i) => `export const ${prefix}${i + 1} = ${i + 1};\n`).join('');

export interface FixtureCommit {
  sha: string;
  path: string;
  start: number;
  end: number;
  /** A human coauthor trailer makes the change shared. */
  shared?: boolean;
  /** A landing PR with another author's commits makes authorship undetermined. */
  undetermined?: boolean;
  /** Without a PR lookup the landing is unknown, so the contribution is provisional. */
  provisional?: boolean;
  author?: 'cand' | 'other';
}

export function fixtureRepo(
  name: string,
  files: { path: string; content: string }[],
  commits: FixtureCommit[],
): PreparedRepo {
  const commitSha = `snap-${name}`;
  const blob = (path: string) => `blob-${name}-${path}`;
  const summaries: CommitSummary[] = commits.map((c) => ({
    sha: c.sha,
    parents: ['parent'],
    message: c.shared ? 'Change\n\nBody.\n\nCo-authored-by: Other <other@example.com>' : 'Change',
    author: { name: 'A', email: 'a@example.com' },
    authorAccount: c.author === 'other' ? OTHER : ME,
    committer: null,
    committerAccount: null,
  }));
  const details = new Map<string, CommitDetail>(
    commits.map((c) => {
      const count = c.end - c.start + 1;
      const patch = `@@ -0,0 +${c.start},${count} @@\n${'+added\n'.repeat(count)}`;
      return [
        c.sha,
        {
          outcome: 'complete',
          files: [{ path: c.path, status: 'modified', sha: blob(c.path), changes: count, patch }],
        },
      ];
    }),
  );
  const prLookups = new Map<string, PrLookup>(
    commits
      .filter((c) => !c.provisional)
      .map((c, i): [string, PrLookup] => [
        c.sha,
        {
          landing: 'landing',
          prNumber: 10 + i,
          ...(c.undetermined && {
            prCommits: [
              { ...summaries[0]!, sha: `${c.sha}-other`, authorAccount: OTHER, message: 'Other' },
            ],
          }),
        },
      ]),
  );
  return {
    owner: 'octo',
    repo: name,
    collectedFor: CANDIDATE.githubUserId,
    snapshot: {
      commitSha,
      files: files.map((f) => ({ path: f.path, sha: blob(f.path), content: f.content })),
      skipped: [],
    },
    collected: {
      repository: { owner: 'octo', repo: name, commitSha, fork: false, ownerId: 101 },
      commits: summaries,
      details,
      prLookups,
      gaps: [],
      requestsUsed: 1,
    },
  };
}

export function fixtureCandidate(
  repos: PreparedCandidate['repos'],
  overrides: Partial<PreparedCandidate> = {},
): PreparedCandidate {
  return {
    subject: { kind: 'demo', key: 'cand' },
    identity: CANDIDATE,
    repos,
    resume: null,
    dataUse: 'approved_public_demo',
    ...overrides,
  };
}
