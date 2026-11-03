import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SeedSchema } from './demo-seed.js';

const FILE = fileURLToPath(new URL('../../../../data/demo/seed/demo-seed.json', import.meta.url));
const committed = () => JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, any>;

describe('demo seed allowlist', () => {
  it('accepts the committed seed, which holds no repository code or model output', () => {
    expect(SeedSchema.safeParse(committed()).success).toBe(true);
    const text = readFileSync(FILE, 'utf8');
    // Results keep evidence locations (`evidence` refs), never the text; that is checked by schema.
    for (const field of ['"prepared"', '"preparedSha256"', '"rawOutput"', '"snapshot"']) {
      expect(text).not.toContain(field);
    }
  });

  it.each([
    ['a prepared snapshot', (s: Record<string, any>) => (s.candidates[0].prepared = { repos: [] })],
    ['evidence text', (s: Record<string, any>) => (s.assessments[0].evidence = { items: [] })],
    ['raw model output', (s: Record<string, any>) => (s.assessments[0].rawOutput = {})],
    [
      'an extra repository field',
      (s: Record<string, any>) =>
        (s.candidates.find((c: any) => c.repositories.length).repositories[0].snapshot = {}),
    ],
  ])('rejects a seed carrying %s', (_name, inject) => {
    const seed = committed();
    inject(seed);
    expect(SeedSchema.safeParse(seed).success).toBe(false);
  });

  it('only records seeker spend scopes', () => {
    const seed = committed();
    seed.spend.push({ scope: 'daily:2026-11-03', spentMicroUsd: 1 });
    expect(SeedSchema.safeParse(seed).success).toBe(false);
  });
});
