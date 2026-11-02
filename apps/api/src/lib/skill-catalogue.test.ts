import {
  MarkerReviewSchema,
  SKILL_CATALOGUE,
  SKILL_IDS,
  SkillCatalogueSchema,
} from '@clearhire/shared';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CATALOGUE_MESSAGE, catalogueHash } from './muse.js';

const v1 = JSON.parse(
  readFileSync(
    new URL('../../../../data/skills/clearhire-skills-v1.json', import.meta.url),
    'utf8',
  ),
) as { categories: { id: string; skills: { id: string }[] }[] };

it('keeps the 100 stable v1 skill IDs in their categories', () => {
  const v1Ids = v1.categories.flatMap((c) => c.skills.map((s) => `${c.id}/${s.id}`));
  expect(SKILL_CATALOGUE.skills.map((s) => `${s.categoryId}/${s.id}`)).toEqual(v1Ids);
  expect(new Set(SKILL_IDS).size).toBe(100);
});

it('gives every skill a definition and a distinct requirement for each level', () => {
  expect(SkillCatalogueSchema.safeParse(SKILL_CATALOGUE).success).toBe(true);
  for (const skill of SKILL_CATALOGUE.skills) {
    expect(skill.definition.length).toBeGreaterThan(20);
    const requires = [1, 2, 3].map((l) => skill.levels[l as 1 | 2 | 3].requires);
    expect(requires.every((r) => r.length > 20)).toBe(true);
    expect(new Set(requires).size).toBe(3);
  }
  expect(SKILL_CATALOGUE.provenance).toMatch(/not an ESCO standard/);
});

it('renders examples apart from requirements', () => {
  expect(CATALOGUE_MESSAGE).toContain(
    '  2: Keeps request and response shapes consistent across operations',
  );
  expect(CATALOGUE_MESSAGE).toContain('     examples (not required): Pagination,');
});

it('hashes the catalogue deterministically', () => {
  expect(catalogueHash()).toBe(catalogueHash());
  expect(catalogueHash()).toMatch(/^[0-9a-f]{64}$/);
});

describe('MarkerReviewSchema', () => {
  const markers = () =>
    SKILL_IDS.map((skill_id) => ({
      skill_id,
      expected_level: 0,
      muse_level: 0,
      agrees: true,
      reason: 'Not shown',
      evidence_refs: [] as string[],
    }));

  it('accepts one decision for every marker', () => {
    expect(MarkerReviewSchema.safeParse({ id: 'p', markers: markers() }).success).toBe(true);
  });

  it('rejects missing or duplicated markers', () => {
    const missing = markers().slice(1);
    const duplicated = [...missing, missing[0]!];
    expect(MarkerReviewSchema.safeParse({ id: 'p', markers: missing }).success).toBe(false);
    expect(MarkerReviewSchema.safeParse({ id: 'p', markers: duplicated }).success).toBe(false);
  });

  it('rejects a contradictory agrees flag and an unsupported positive level', () => {
    const contradictory = markers();
    contradictory[0] = { ...contradictory[0]!, muse_level: 2 };
    const unsupported = markers();
    unsupported[0] = { ...unsupported[0]!, expected_level: 1, agrees: false };
    expect(MarkerReviewSchema.safeParse({ id: 'p', markers: contradictory }).success).toBe(false);
    expect(MarkerReviewSchema.safeParse({ id: 'p', markers: unsupported }).success).toBe(false);
  });
});
