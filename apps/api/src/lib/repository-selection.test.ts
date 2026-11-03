import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { db, databaseIsUp, pool } from '../db/client.js';
import { repositorySelections } from '../db/schema.js';
import { pickDefaults, saveSelection, type PublicRepo } from './repository-selection.js';

const repo = (id: number, stars: number, pushedAt: string, extra: Partial<PublicRepo> = {}) => ({
  id,
  fullName: `octo/r${id}`,
  description: null,
  stars,
  pushedAt,
  fork: false,
  archived: false,
  size: 10,
  ...extra,
});
const day = (d: number) => `2026-01-${String(d).padStart(2, '0')}T00:00:00Z`;
const ids = (repos: PublicRepo[]) => repos.map((r) => r.id);

describe('pickDefaults', () => {
  it('alternates most starred and most recently pushed, skipping repositories already chosen', () => {
    // Starred: 1, 2, 3, 4, 5, 7. Recent: 1, 2, 3, 4, 6, 7.
    const repos = [
      repo(1, 70, day(28)),
      repo(2, 60, day(27)),
      repo(3, 50, day(26)),
      repo(4, 40, day(25)),
      repo(5, 30, day(10)),
      repo(6, 0, day(24)),
      repo(7, 20, day(20)),
    ];
    expect(ids(pickDefaults(repos, 6))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('continues from the other list when one is exhausted, and stops at the cap', () => {
    const many = Array.from({ length: 15 }, (_, i) => repo(i + 1, 100 - i, day(i + 1)));
    const picked = pickDefaults(many);
    expect(picked).toHaveLength(10);
    expect(new Set(ids(picked)).size).toBe(10);
    // Stars descend with id, pushes ascend with id: the two lists alternate from each end.
    expect(ids(picked)).toEqual([1, 15, 2, 14, 3, 13, 4, 12, 5, 11]);
    const two = [repo(1, 5, day(1)), repo(2, 1, day(2))];
    expect(ids(pickDefaults(two))).toEqual([1, 2]);
  });

  it('breaks ties deterministically, keeps forks and drops empty repositories', () => {
    const tied = [
      repo(3, 1, day(5), { fullName: 'octo/c' }),
      repo(1, 1, day(5), { fullName: 'octo/a', fork: true }),
      repo(2, 1, day(5), { fullName: 'octo/b', size: 0 }),
    ];
    expect(ids(pickDefaults(tied))).toEqual([1, 3]);
    expect(ids(pickDefaults([...tied].reverse()))).toEqual([1, 3]);
    expect(pickDefaults([])).toEqual([]);
  });
});

const up = await databaseIsUp();
const KEY = `test-${randomUUID()}`;
afterAll(async () => {
  if (up) await db.delete(repositorySelections).where(eq(repositorySelections.subjectKey, KEY));
  await pool.end();
});

describe.runIf(up)('saveSelection (Postgres)', () => {
  it('serializes concurrent replacements, so the cap of 10 always holds', async () => {
    const subject = { kind: 'user' as const, key: KEY };
    const set = (from: number) =>
      Array.from({ length: 10 }, (_, i) => ({
        id: from + i,
        fullName: `me/r${from + i}`,
        pushedAt: null,
      }));
    await Promise.all([
      saveSelection(subject, set(100), 'user'),
      saveSelection(subject, set(200), 'user'),
      saveSelection(subject, set(300), 'user'),
    ]);
    const active = await db
      .select()
      .from(repositorySelections)
      .where(and(eq(repositorySelections.subjectKey, KEY), eq(repositorySelections.active, true)));
    expect(active).toHaveLength(10);
    // Exactly one of the sets won, whole.
    expect(new Set(active.map((r) => Math.floor(r.repoId / 100))).size).toBe(1);
  });
});
