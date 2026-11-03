// Which repositories a subject's markers come from: at most 10. Demo candidates get defaults from
// listing metadata (most starred and most recently pushed, alternating); live users choose their
// own. Listing reads metadata only: no tree, no file content.
import type { Octokit } from '@octokit/rest';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { repositorySelections } from '../db/schema.js';
import { toIngestError } from './ingest.js';

export const MAX_SELECTED = 10;

export interface PublicRepo {
  id: number;
  fullName: string;
  description: string | null;
  stars: number;
  pushedAt: string | null;
  fork: boolean;
  archived: boolean;
  /** GitHub's size in KB; 0 means the repository holds nothing to grade. */
  size: number;
}

/** Every public repository the account owns, forks included, from paginated listing metadata. */
export async function listPublicRepos(octokit: Octokit, login: string): Promise<PublicRepo[]> {
  try {
    const repos = await octokit.paginate(octokit.rest.repos.listForUser, {
      username: login,
      type: 'owner',
      per_page: 100,
    });
    return repos
      .filter((r) => !r.private)
      .map((r) => ({
        id: r.id,
        fullName: r.full_name,
        description: r.description ?? null,
        stars: r.stargazers_count ?? 0,
        pushedAt: r.pushed_at ?? null,
        fork: r.fork,
        archived: r.archived ?? false,
        size: r.size ?? 0,
      }));
  } catch (err) {
    throw toIngestError(err, 'listForUser', new AbortController().signal);
  }
}

const byName = (a: PublicRepo, b: PublicRepo) => {
  const x = a.fullName.toLowerCase();
  const y = b.fullName.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
};
const pushed = (r: PublicRepo) => (r.pushedAt === null ? 0 : Date.parse(r.pushedAt));
export const byStars = (a: PublicRepo, b: PublicRepo) =>
  b.stars - a.stars || pushed(b) - pushed(a) || byName(a, b);
export const byPushed = (a: PublicRepo, b: PublicRepo) => pushed(b) - pushed(a) || byName(a, b);

/**
 * Demo defaults: the top 10 by stars and the top 10 by latest push, taken alternately starting with
 * stars, each turn the list's next repository not already chosen; when one list runs out the other
 * continues. Empty repositories hold nothing to grade; forks are kept (attribution decides).
 */
export function pickDefaults(repos: PublicRepo[], n = MAX_SELECTED): PublicRepo[] {
  const pool = repos.filter((r) => r.size > 0);
  const lists = [
    { repos: [...pool].sort(byStars).slice(0, n), next: 0 },
    { repos: [...pool].sort(byPushed).slice(0, n), next: 0 },
  ];
  const chosen = new Map<number, PublicRepo>();
  const take = (list: (typeof lists)[number]) => {
    while (list.next < list.repos.length && chosen.has(list.repos[list.next]!.id)) list.next++;
    const repo = list.repos[list.next];
    if (!repo) return false;
    list.next++;
    chosen.set(repo.id, repo);
    return true;
  };
  for (let turn = 0; chosen.size < n; turn++) {
    const [first, second] = turn % 2 === 0 ? [lists[0]!, lists[1]!] : [lists[1]!, lists[0]!];
    if (!take(first) && !take(second)) break;
  }
  return [...chosen.values()];
}

type Subject = { kind: 'demo' | 'user'; key: string };
const ofSubject = (s: Subject) =>
  and(eq(repositorySelections.subjectKind, s.kind), eq(repositorySelections.subjectKey, s.key));

/**
 * Stores exactly `repos` as the active selection, in order. A repository chosen before keeps its
 * progress and saved results; one no longer chosen is deactivated, never deleted.
 */
export async function saveSelection(
  subject: Subject,
  repos: Pick<PublicRepo, 'id' | 'fullName' | 'pushedAt'>[],
  source: 'demo_default' | 'user',
): Promise<void> {
  if (repos.length > MAX_SELECTED) throw new RangeError(`At most ${MAX_SELECTED} repositories`);
  if (new Set(repos.map((r) => r.id)).size !== repos.length) {
    throw new RangeError('Duplicate repository');
  }
  await db.transaction(async (tx) => {
    // One replacement per subject at a time, so concurrent saves can never exceed the cap.
    const lock = `repository_selections:${subject.kind}:${subject.key}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lock}))`);
    const ids = repos.map((r) => r.id);
    await tx
      .update(repositorySelections)
      .set({ active: false })
      .where(
        and(
          ofSubject(subject),
          ids.length > 0 ? notInArray(repositorySelections.repoId, ids) : undefined,
        ),
      );
    for (const [position, r] of repos.entries()) {
      const pushedAt = r.pushedAt === null ? null : new Date(r.pushedAt);
      await tx
        .insert(repositorySelections)
        .values({
          subjectKind: subject.kind,
          subjectKey: subject.key,
          repoId: r.id,
          fullName: r.fullName,
          position,
          source,
          pushedAt,
        })
        .onConflictDoUpdate({
          target: [
            repositorySelections.subjectKind,
            repositorySelections.subjectKey,
            repositorySelections.repoId,
          ],
          set: {
            fullName: r.fullName,
            position,
            source,
            pushedAt,
            active: true,
            confirmedAt: new Date(),
          },
        });
    }
  });
}

/** Refreshes the last-push time of selected repositories from a listing, to flag changes. */
export async function refreshPushedAt(subject: Subject, listing: PublicRepo[]): Promise<void> {
  const byId = new Map(listing.map((r) => [r.id, r]));
  const rows = await db
    .select({ repoId: repositorySelections.repoId })
    .from(repositorySelections)
    .where(
      and(
        ofSubject(subject),
        inArray(
          repositorySelections.repoId,
          listing.map((r) => r.id),
        ),
      ),
    );
  for (const { repoId } of rows) {
    const r = byId.get(repoId)!;
    await db
      .update(repositorySelections)
      .set({ pushedAt: r.pushedAt === null ? null : new Date(r.pushedAt), fullName: r.fullName })
      .where(and(ofSubject(subject), eq(repositorySelections.repoId, repoId)));
  }
}
