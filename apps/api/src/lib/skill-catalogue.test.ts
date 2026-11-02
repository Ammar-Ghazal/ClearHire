import { SKILL_CATALOGUE, SKILL_IDS } from '@clearhire/shared';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { catalogueHash } from './muse.js';

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

it('gives every skill a definition and distinct criteria for each level', () => {
  for (const skill of SKILL_CATALOGUE.skills) {
    expect(skill.definition.length).toBeGreaterThan(20);
    const levels = [skill.levels[1], skill.levels[2], skill.levels[3]];
    expect(levels.every((l) => l.length > 20)).toBe(true);
    expect(new Set(levels).size).toBe(3);
  }
  expect(SKILL_CATALOGUE.provenance).toMatch(/not an ESCO standard/);
});

it('hashes the catalogue deterministically', () => {
  expect(catalogueHash()).toBe(catalogueHash());
  expect(catalogueHash()).toMatch(/^[0-9a-f]{64}$/);
});
