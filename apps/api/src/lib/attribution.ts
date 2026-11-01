// Links a candidate's GitHub identity to commit evidence at a pinned snapshot. GitHub metadata shows
// which account a change is recorded under, never who physically wrote it or how well they know it.
// Unavailable or provisional evidence is incomplete evidence, never a reason to lower a skill score.
import type { RepoSnapshot } from './ingest.js';
import { filterEntry } from './ingest-filter.js';
import type { AnalysisPackets, Chunk } from './packets.js';

export interface CandidateIdentity {
  githubUserId: number;
  login: string;
  /** Only addresses GitHub reports as verified. */
  verifiedEmails: string[];
}

export type MatchMethod = 'linked_account' | 'account_email' | 'noreply_id';
export type OtherKind = 'other' | 'unknown' | 'bot' | 'ai_declared';
export type Role = 'author' | 'coauthor' | 'committer';
export type Resolution =
  | { kind: 'candidate'; method: MatchMethod }
  | { kind: OtherKind; accountId?: number };

export interface GitIdentity {
  name: string | null;
  email: string | null;
}

export interface LinkedAccount {
  id: number;
  login: string;
  type: string;
}

export interface CommitSummary {
  sha: string;
  parents: string[];
  message: string;
  author: GitIdentity | null;
  authorAccount: LinkedAccount | null;
  committer: GitIdentity | null;
  committerAccount: LinkedAccount | null;
}

export interface CommitFile {
  path: string;
  status: string;
  /** Blob SHA after the change. */
  sha: string | null;
  changes: number;
  patch?: string;
}

export interface CommitDetail {
  files: CommitFile[];
  outcome: 'complete' | 'files_capped' | 'failed';
}

export type Landing = 'landing' | 'not_landing' | 'unknown';

export interface PrLookup {
  landing: Landing;
  prNumber?: number;
  /** Present only for a landing, whose PR commit list was complete. */
  prCommits?: CommitSummary[];
}

export type GapReason =
  | 'history_capped'
  | 'commit_details_capped'
  | 'commit_files_capped'
  | 'patch_missing'
  | 'commit_detail_failed'
  | 'pr_lookup_incomplete';

export interface Gap {
  reason: GapReason;
  commitSha?: string;
  path?: string;
}

export interface CollectedContributions {
  repository: { owner: string; repo: string; commitSha: string; fork: boolean; ownerId: number };
  /** Inspected history, newest first. */
  commits: CommitSummary[];
  details: Map<string, CommitDetail>;
  prLookups: Map<string, PrLookup>;
  gaps: Gap[];
  requestsUsed: number;
}

export interface ContributionRange {
  path: string;
  start: number;
  end: number;
  mapping: 'exact' | 'historical' | 'deleted';
  analysis: 'snapshot_chunks' | 'unavailable';
  /** Context only: the evidence is `start`–`end`, never the rest of a linked chunk. */
  chunkIds: string[];
}

export interface Contribution {
  commitSha: string;
  parents: string[];
  roles: Role[];
  matchMethods: MatchMethod[];
  authorship: 'sole' | 'shared' | 'undetermined' | 'not_author';
  provisional: boolean;
  others: { role: Role; kind: OtherKind; accountId?: number; email?: string }[];
  aiCoauthorDeclared: boolean;
  prNumber?: number;
  landing: Landing;
  patch: 'complete' | 'partial' | 'not_fetched';
  ranges: ContributionRange[];
}

export const LIMITATIONS = ['squash_hidden_contributions_not_discovered'] as const;

export interface ContributionReport {
  /** `ownerIsCandidate` is informational: owning a repository earns no credit. */
  repository: { owner: string; repo: string; commitSha: string; fork: boolean; ownerIsCandidate: boolean };
  candidate: { githubUserId: number; login: string };
  contributions: Contribution[];
  coverage: { inspectedCommits: number; mergeCommits: number; requestsUsed: number; gaps: Gap[] };
  limitations: typeof LIMITATIONS;
}

// ---- Identity ----

// Small heuristic list; an unlisted AI resolves to unknown, which makes the work shared.
const AI_EMAILS = new Set(['noreply@anthropic.com']);
const NOREPLY = /^(?:(\d+)\+)?([^@\s]+)@users\.noreply\.github\.com$/;
const TRAILER = /^co-authored-by:\s*(.*?)\s*<([^<>\s]+)>\s*$/i;

function resolveEmail(
  email: string | null,
  candidate: CandidateIdentity,
  context: 'actor' | 'trailer',
): Resolution {
  const address = email?.trim().toLowerCase() ?? '';
  if (AI_EMAILS.has(address)) return { kind: 'ai_declared' };

  const noreply = NOREPLY.exec(address);
  if (noreply) {
    if (noreply[2]!.endsWith('[bot]')) return { kind: context === 'trailer' ? 'ai_declared' : 'bot' };
    // The legacy USERNAME@ form proves nothing: usernames can be reused after a rename.
    if (noreply[1] === undefined) return { kind: 'unknown' };
    const accountId = Number(noreply[1]);
    return accountId === candidate.githubUserId
      ? { kind: 'candidate', method: 'noreply_id' }
      : { kind: 'other', accountId };
  }

  const verified = candidate.verifiedEmails.some((e) => e.trim().toLowerCase() === address);
  return address && verified ? { kind: 'candidate', method: 'account_email' } : { kind: 'unknown' };
}

/** A linked account decides on its own; email only applies to unlinked actors. */
function resolveActor(
  git: GitIdentity | null,
  account: LinkedAccount | null,
  candidate: CandidateIdentity,
): Resolution {
  if (account) {
    if (account.type === 'Bot' || account.login.endsWith('[bot]') || account.login === 'web-flow') {
      return { kind: 'bot', accountId: account.id };
    }
    return account.id === candidate.githubUserId
      ? { kind: 'candidate', method: 'linked_account' }
      : { kind: 'other', accountId: account.id };
  }
  return resolveEmail(git?.email ?? null, candidate, 'actor');
}

/** `Co-authored-by` trailers from the final paragraph, deduplicated by email. */
export function parseCoauthors(message: string): GitIdentity[] {
  const paragraphs = message.replace(/\r\n?/g, '\n').trimEnd().split(/\n[ \t]*\n/);
  if (paragraphs.length < 2) return [];

  const seen = new Set<string>();
  const coauthors: GitIdentity[] = [];
  for (const line of paragraphs.at(-1)!.split('\n')) {
    const match = TRAILER.exec(line.trim());
    if (!match || seen.has(match[2]!.toLowerCase())) continue;
    seen.add(match[2]!.toLowerCase());
    coauthors.push({ name: match[1] || null, email: match[2]! });
  }
  return coauthors;
}

interface Actor {
  role: Role;
  resolution: Resolution;
  email: string | null;
}

function commitActors(commit: CommitSummary, candidate: CandidateIdentity): Actor[] {
  return [
    {
      role: 'author',
      resolution: resolveActor(commit.author, commit.authorAccount, candidate),
      email: commit.author?.email ?? null,
    },
    {
      role: 'committer',
      resolution: resolveActor(commit.committer, commit.committerAccount, candidate),
      email: commit.committer?.email ?? null,
    },
    ...parseCoauthors(commit.message).map((c): Actor => ({
      role: 'coauthor',
      resolution: resolveEmail(c.email, candidate, 'trailer'),
      email: c.email,
    })),
  ];
}

const isCandidate = (a: Actor) => a.resolution.kind === 'candidate';
const isOtherHumanAuthor = (a: Actor) =>
  a.role !== 'committer' && (a.resolution.kind === 'other' || a.resolution.kind === 'unknown');

/** True when the commit's own metadata names the candidate as author or coauthor. */
export function isAuthoredByCandidate(commit: CommitSummary, candidate: CandidateIdentity): boolean {
  return commitActors(commit, candidate).some((a) => a.role !== 'committer' && isCandidate(a));
}

// ---- Patches ----

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

interface LineRange {
  start: number;
  end: number;
}

interface Hunk {
  added: LineRange[];
  removed: LineRange | null;
}

/** Added runs use new-side line numbers; removed lines use old-side numbers. */
function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let hunk: Hunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.split('\n')) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      hunk = { added: [], removed: null };
      hunks.push(hunk);
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
    } else if (hunk && line.startsWith('+')) {
      const last = hunk.added.at(-1);
      if (last && last.end === newLine - 1) last.end = newLine;
      else hunk.added.push({ start: newLine, end: newLine });
      newLine++;
    } else if (hunk && line.startsWith('-')) {
      hunk.removed = { start: hunk.removed?.start ?? oldLine, end: oldLine };
      oldLine++;
    } else if (hunk && line.startsWith(' ')) {
      oldLine++;
      newLine++;
    }
  }
  return hunks;
}

// Reasons `filterEntry` derives from the path alone. Commit file data has no mode or size, so
// symlink, submodule and too_large can't be known and are never claimed.
const PATH_EXCLUSIONS = new Set([
  'unsafe_path',
  'dependency',
  'build_output',
  'lockfile',
  'credential',
  'binary',
]);

function isExcluded(file: CommitFile): boolean {
  const reason = filterEntry(
    { path: file.path, type: 'blob', mode: '100644', sha: file.sha ?? '' },
    Number.MAX_SAFE_INTEGER,
  );
  return reason !== null && PATH_EXCLUSIONS.has(reason);
}

interface SnapshotIndex {
  blobByPath: Map<string, string>;
  chunksByPath: Map<string, Chunk[]>;
}

function rangesAndPatch(
  commitSha: string,
  detail: CommitDetail,
  snapshot: SnapshotIndex,
  gaps: Gap[],
): Pick<Contribution, 'patch' | 'ranges'> {
  let patch: Contribution['patch'] = detail.outcome === 'complete' ? 'complete' : 'partial';
  const ranges: ContributionRange[] = [];

  for (const file of detail.files) {
    if (isExcluded(file)) continue;
    if (file.patch === undefined) {
      if (file.status === 'renamed' && file.changes === 0) continue;
      patch = 'partial';
      gaps.push({ reason: 'patch_missing', commitSha, path: file.path });
      continue;
    }

    const exact = file.sha !== null && snapshot.blobByPath.get(file.path) === file.sha;
    const chunks = exact ? (snapshot.chunksByPath.get(file.path) ?? []) : [];
    for (const hunk of parseHunks(file.patch)) {
      for (const { start, end } of hunk.added) {
        const chunkIds = chunks.filter((c) => c.startLine <= end && c.endLine >= start).map((c) => c.id);
        ranges.push({
          path: file.path,
          start,
          end,
          mapping: exact ? 'exact' : 'historical',
          analysis: chunkIds.length > 0 ? 'snapshot_chunks' : 'unavailable',
          chunkIds,
        });
      }
      if (hunk.added.length === 0 && hunk.removed) {
        ranges.push({
          path: file.path,
          ...hunk.removed,
          mapping: 'deleted',
          analysis: 'unavailable',
          chunkIds: [],
        });
      }
    }
  }
  return { patch, ranges };
}

// ---- Report ----

function otherEntry(actor: Actor): Contribution['others'][number] {
  const { resolution } = actor;
  if (resolution.kind === 'candidate') throw new Error('unreachable');
  return {
    role: actor.role,
    kind: resolution.kind,
    ...(resolution.accountId !== undefined && { accountId: resolution.accountId }),
    ...((resolution.kind === 'unknown' || resolution.kind === 'ai_declared') &&
      actor.email !== null && { email: actor.email }),
  };
}

/** Classifies collected commits for one candidate against the snapshot they were collected for. */
export function attributeContributions(
  collected: CollectedContributions,
  candidate: CandidateIdentity,
  context: { snapshot: RepoSnapshot; packets: AnalysisPackets },
): ContributionReport {
  const { repository } = collected;
  if (
    context.snapshot.commitSha !== repository.commitSha ||
    context.packets.commitSha !== repository.commitSha ||
    context.packets.repository.owner.toLowerCase() !== repository.owner.toLowerCase() ||
    context.packets.repository.repo.toLowerCase() !== repository.repo.toLowerCase()
  ) {
    throw new RangeError('Snapshot packets do not match the inspected repository and commit');
  }

  const chunksByPath = new Map<string, Chunk[]>();
  for (const chunk of context.packets.chunks) {
    chunksByPath.set(chunk.path, [...(chunksByPath.get(chunk.path) ?? []), chunk]);
  }
  const snapshot: SnapshotIndex = {
    blobByPath: new Map(context.snapshot.files.map((f) => [f.path, f.sha])),
    chunksByPath,
  };

  const gaps = [...collected.gaps];
  const contributions: Contribution[] = [];
  let mergeCommits = 0;

  for (const commit of collected.commits) {
    if (commit.parents.length > 1) {
      mergeCommits++;
      continue;
    }
    const actors = commitActors(commit, candidate);
    const mine = actors.filter(isCandidate);
    if (mine.length === 0) continue;

    const roles = [...new Set(mine.map((a) => a.role))];
    const authored = roles.some((r) => r !== 'committer');
    const lookup = collected.prLookups.get(commit.sha) ?? { landing: 'unknown' };

    // A PR-wide list can only downgrade a landing: the merge method is unknown, and a rebased
    // commit carries only its own patch.
    const prHasOthers = (lookup.prCommits ?? []).some((c) =>
      commitActors(c, candidate).some(isOtherHumanAuthor),
    );
    const authorship: Contribution['authorship'] = !authored
      ? 'not_author'
      : actors.some(isOtherHumanAuthor)
        ? 'shared'
        : lookup.landing === 'landing' && prHasOthers
          ? 'undetermined'
          : 'sole';

    const detail = collected.details.get(commit.sha);
    const evidence: Pick<Contribution, 'patch' | 'ranges'> =
      authored && detail
        ? rangesAndPatch(commit.sha, detail, snapshot, gaps)
        : { patch: 'not_fetched', ranges: [] };

    contributions.push({
      commitSha: commit.sha,
      parents: commit.parents,
      roles,
      matchMethods: [
        ...new Set(mine.flatMap((a) => (a.resolution.kind === 'candidate' ? [a.resolution.method] : []))),
      ],
      authorship,
      provisional: lookup.landing === 'unknown',
      others: actors.filter((a) => !isCandidate(a)).map(otherEntry),
      aiCoauthorDeclared: actors.some(
        (a) => a.role === 'coauthor' && a.resolution.kind === 'ai_declared',
      ),
      ...(lookup.prNumber !== undefined && { prNumber: lookup.prNumber }),
      landing: lookup.landing,
      ...evidence,
    });
  }

  return {
    repository: {
      owner: repository.owner,
      repo: repository.repo,
      commitSha: repository.commitSha,
      fork: repository.fork,
      ownerIsCandidate: repository.ownerId === candidate.githubUserId,
    },
    candidate: { githubUserId: candidate.githubUserId, login: candidate.login },
    contributions,
    coverage: {
      inspectedCommits: collected.commits.length,
      mergeCommits,
      requestsUsed: collected.requestsUsed,
      gaps,
    },
    limitations: LIMITATIONS,
  };
}
