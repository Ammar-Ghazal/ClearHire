// Links a candidate's GitHub identity to commit evidence at a pinned snapshot. GitHub metadata shows
// which account a change is recorded under, never who physically wrote it or how well they know it.
// Unavailable or provisional evidence is incomplete evidence, never a reason to lower a skill score.
import type { RepoSnapshot } from './ingest.js';
import type { AnalysisPackets, Chunk } from './packets.js';

/** Bump when attribution rules change, so cached analyses built on older results are not reused. */
export const ATTRIBUTION_VERSION = 2;

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

/** Snapshot lines that `git blame` at the pinned commit assigns to one commit. */
export interface BlameRange {
  path: string;
  start: number;
  end: number;
}

export type Landing = 'landing' | 'not_landing' | 'unknown';

export interface PrLookup {
  landing: Landing;
  prNumber?: number;
  /** Present only for a landing, whose PR commit list was complete. */
  prCommits?: CommitSummary[];
}

export type GapReason = 'history_capped' | 'blame_incomplete' | 'pr_lookup_incomplete';

export interface Gap {
  reason: GapReason;
  commitSha?: string;
  path?: string;
}

export interface CollectedContributions {
  repository: { owner: string; repo: string; commitSha: string; fork: boolean; ownerId: number };
  /** Inspected history, newest first. */
  commits: CommitSummary[];
  /** Blame at the pinned commit, by commit SHA: only commits the candidate authored or coauthored. */
  blame: Map<string, BlameRange[]>;
  prLookups: Map<string, PrLookup>;
  gaps: Gap[];
  requestsUsed: number;
}

export interface ContributionRange {
  path: string;
  start: number;
  end: number;
  /** Blame is taken at the snapshot commit, so every range is in the snapshot's own lines. */
  mapping: 'exact';
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

/** True when an inspected commit's author or coauthor resolved to no account: it may be anyone. */
export function hasUnresolvedAuthors(
  collected: CollectedContributions,
  candidate: CandidateIdentity,
): boolean {
  return collected.commits.some((c) =>
    commitActors(c, candidate).some((a) => a.role !== 'committer' && a.resolution.kind === 'unknown'),
  );
}

/**
 * True only when inspected history conclusively holds nothing of the candidate's: it is uncapped
 * and gap-free, no commit names the candidate, and every author and coauthor resolved to someone.
 */
export function conclusivelyNoContributions(
  collected: CollectedContributions,
  candidate: CandidateIdentity,
): boolean {
  return (
    collected.gaps.length === 0 &&
    !collected.commits.some((c) => isAuthoredByCandidate(c, candidate)) &&
    !hasUnresolvedAuthors(collected, candidate)
  );
}

// ---- Blame ----

/** Blame ranges of one commit, each linked to the snapshot chunks it overlaps (context only). */
function blameRanges(
  ranges: BlameRange[],
  chunksByPath: Map<string, Chunk[]>,
): ContributionRange[] {
  return ranges.map(({ path, start, end }) => {
    const chunkIds = (chunksByPath.get(path) ?? [])
      .filter((c) => c.startLine <= end && c.endLine >= start)
      .map((c) => c.id);
    return {
      path,
      start,
      end,
      mapping: 'exact',
      analysis: chunkIds.length > 0 ? 'snapshot_chunks' : 'unavailable',
      chunkIds,
    };
  });
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

    const ranges = authored ? blameRanges(collected.blame.get(commit.sha) ?? [], chunksByPath) : [];

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
      ranges,
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
