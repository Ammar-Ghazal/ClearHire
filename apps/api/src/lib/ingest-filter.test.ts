import { describe, expect, it } from 'vitest';
import { filterEntry, type TreeEntry } from './ingest-filter.js';

const MAX = 1000;
const file = (path: string, extra: Partial<TreeEntry> = {}): TreeEntry => ({
  path,
  type: 'blob',
  mode: '100644',
  sha: 'abc',
  size: 10,
  ...extra,
});

describe('filterEntry', () => {
  it.each([
    ['node_modules/a.js', 'dependency'],
    ['pkg/vendor/a.go', 'dependency'],
    ['apps/web/dist/x.js', 'build_output'],
    ['target/release/main.rs', 'build_output'],
    ['sub/yarn.lock', 'lockfile'],
    ['pnpm-lock.yaml', 'lockfile'],
    ['go.sum', 'lockfile'],
    ['.env', 'credential'],
    ['config/.env.production', 'credential'],
    ['certs/server.key', 'credential'],
    ['tls.pem', 'credential'],
    ['deploy/id_ed25519', 'credential'],
    ['logo.png', 'binary'],
    ['fonts/a.WOFF2', 'binary'],
    ['../x', 'unsafe_path'],
    ['a/./b', 'unsafe_path'],
    ['a//b', 'unsafe_path'],
    ['a\\b', 'unsafe_path'],
    ['a\nb', 'unsafe_path'],
    ['x'.repeat(513), 'unsafe_path'],
  ])('skips %s as %s', (path, reason) => {
    expect(filterEntry(file(path), MAX)).toBe(reason);
  });

  it.each([
    'src/app.ts',
    'src/lib/crypto.test.ts',
    'package.json',
    'apps/api/drizzle/0000_x.sql',
    '.github/workflows/ci.yml',
    '.env.example',
    '.env.template',
    'id_ed25519.pub',
    'build.gradle',
    'distance.ts',
    'src/output/x.ts',
    'README',
  ])('keeps %s', (path) => {
    expect(filterEntry(file(path), MAX)).toBeNull();
  });

  it('skips files over the size limit', () => {
    expect(filterEntry(file('big.ts', { size: MAX + 1 }), MAX)).toBe('too_large');
    expect(filterEntry(file('ok.ts', { size: MAX }), MAX)).toBeNull();
  });

  it('checks entry type and mode before path rules', () => {
    expect(filterEntry(file('src/link', { mode: '120000' }), MAX)).toBe('symlink');
    expect(filterEntry(file('libs/sub', { type: 'commit', mode: '160000' }), MAX)).toBe('submodule');
    expect(filterEntry(file('node_modules/sub', { type: 'commit', mode: '160000' }), MAX)).toBe(
      'submodule',
    );
    expect(filterEntry(file('src', { type: 'tree', mode: '040000' }), MAX)).toBe('ignore');
    expect(filterEntry(file('bin/run.sh', { mode: '100755' }), MAX)).toBeNull();
    expect(filterEntry(file('odd', { mode: '100664' }), MAX)).toBe('unsupported_entry');
  });
});
