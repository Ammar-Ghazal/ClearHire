import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RepoSnapshot } from './ingest.js';
import {
  type AnalysisPackets,
  type PacketOptions,
  DEFAULT_PACKET_OPTIONS,
  buildPackets,
  redactString,
  resolveOptions,
  splitLines,
} from './packets.js';

const repo = { owner: 'octo', repo: 'demo' };
// Fake secrets are assembled at runtime so secret scanners don't flag this file.
const GITHUB_TOKEN = `ghp_${'a1B2'.repeat(9)}`;
const AWS_KEY = `AKIA${'Z'.repeat(16)}`;
const PEM_BODY = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC';

type Files = Record<string, string>;

function snap(files: Files, skipped: RepoSnapshot['skipped'] = []): RepoSnapshot {
  return {
    commitSha: 'commit-1',
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
    skipped,
  };
}

function build(files: Files, options: Partial<PacketOptions> = {}, skipped?: RepoSnapshot['skipped']) {
  return buildPackets(snap(files, skipped), repo, options);
}

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const lines = (n: number, prefix = 'line') =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}\n`).join('');
const status = (out: AnalysisPackets, path: string) => out.files.find((f) => f.path === path)?.status;
const packet = (out: AnalysisPackets, id: string) => out.packets.find((p) => p.id === id);
const chunkPaths = (out: AnalysisPackets, ids: string[]) =>
  [...new Set(ids.map((id) => out.chunks.find((c) => c.id === id)!.path))];

/** Emitted chunk ranges and budget omissions must partition every chunk-eligible file. */
function expectCoverage(out: AnalysisPackets) {
  for (const file of out.files) {
    if (!['included', 'partial', 'excluded_budget'].includes(file.status)) {
      expect(out.omissions.some((o) => o.path === file.path && o.reason === 'budget')).toBe(false);
      continue;
    }
    const ranges = [
      ...out.chunks.filter((c) => c.path === file.path),
      ...out.omissions.filter((o) => o.path === file.path && o.reason === 'budget'),
    ]
      .map((r) => r as { startLine: number; endLine: number })
      .sort((a, b) => a.startLine - b.startLine);
    let next = 1;
    for (const r of ranges) {
      expect(r.startLine).toBe(next);
      next = r.endLine + 1;
    }
    expect(next).toBe(file.lineCount + 1);
  }
}

describe('resolveOptions', () => {
  it('returns the defaults for {}', () => {
    expect(resolveOptions({})).toEqual(DEFAULT_PACKET_OPTIONS);
  });

  it.each([
    [{ maxChars: -1 }, 'maxChars'],
    [{ maxCharsPerPacket: 1.5 }, 'maxCharsPerPacket'],
    [{ chunkLines: 0 }, 'chunkLines'],
    [{ chunkLines: 1001 }, 'chunkLines'],
    [{ maxContextFiles: 21 }, 'maxContextFiles'],
    [{ maxChars: Number.MAX_SAFE_INTEGER + 1 }, 'maxChars'],
    [{ maxChars: '10' }, 'maxChars'],
    [{ focusPaths: 'src/a.ts' }, 'focusPaths'],
    [{ focusPaths: ['x'.repeat(513)] }, 'focusPaths'],
    [{ secretKnob: 'hunter2hunter2' }, 'secretKnob'],
  ])('rejects %j naming only the key', (input, key) => {
    expect(() => resolveOptions(input as Partial<PacketOptions>)).toThrow(
      new RangeError(`Invalid packet option: ${key}`),
    );
  });
});

describe('lines and hashes', () => {
  it('splits on CRLF, LF and lone CR without inventing a final line', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a')).toEqual([{ text: 'a', eol: '' }]);
    expect(splitLines('a\n')).toEqual([{ text: 'a', eol: '\n' }]);
    expect(splitLines('a\n\n')).toHaveLength(2);
    expect(splitLines('a\r\nb\rc')).toEqual([
      { text: 'a', eol: '\r\n' },
      { text: 'b', eol: '\r' },
      { text: 'c', eol: '' },
    ]);
  });

  it.each([
    ['CRLF', 'const a = 1;\r\nconst b = 2;\r\n'],
    ['CR', 'const a = 1;\rconst b = 2;\r'],
    ['BOM', '﻿const a = 1;\nconst b = 2;\n'],
    ['no final newline', 'const a = 1;\nconst b = 2;'],
  ])('keeps %s bytes so chunk and file hashes match the original', (_, content) => {
    const out = build({ 'src/a.ts': content });
    const [chunk] = out.chunks;
    expect(chunk!.text).toBe(content);
    expect(chunk!.sha256).toBe(sha(content));
    expect(out.files[0]!.sha256).toBe(sha(content));
    expect(out.files[0]!.lineCount).toBe(2);
  });

  it('chunks into fixed windows with 1-based inclusive ranges', () => {
    const out = build({ 'src/a.ts': lines(300) }, { chunkLines: 120 });
    expect(out.chunks.map((c) => c.id)).toEqual([
      'src/a.ts#L1-L120',
      'src/a.ts#L121-L240',
      'src/a.ts#L241-L300',
    ]);
    expect(out.chunks[2]!.text).toBe(lines(300).split('\n').slice(240, 300).join('\n') + '\n');
  });
});

describe('classification', () => {
  it('assigns kinds by first match and applies exclusions to every kind', () => {
    const out = build({
      'package.json': `{"name":"x","description":"${'d'.repeat(1001)}"}`,
      'requirements-dev.txt': 'pytest==8.0\n',
      'docs/a.test.ts': 'test\n',
      '.github/workflows/ci.yml': 'on: push\n',
      'README.md': '# Demo\n',
      'src/app.ts': 'export {};\n',
      'src/empty.ts': '',
      'web/vendor.min.js': 'x\n',
      'src/gen.ts': '// Code generated by tool. DO NOT EDIT.\nexport {};\n',
    });
    const kinds = Object.fromEntries(out.files.map((f) => [f.path, [f.kind, f.status]]));
    expect(kinds).toEqual({
      '.github/workflows/ci.yml': ['ci', 'included'],
      'README.md': ['doc', 'included'],
      'docs/a.test.ts': ['test', 'unpaired'],
      'package.json': ['manifest', 'long_line'],
      'requirements-dev.txt': ['manifest', 'summarized'],
      'src/app.ts': ['source', 'included'],
      'src/empty.ts': ['source', 'empty'],
      'src/gen.ts': ['source', 'generated'],
      'web/vendor.min.js': ['source', 'generated'],
    });
  });

  it('copies every ingestion skip unchanged', () => {
    const skipped = [
      { path: 'node_modules/x/index.js', reason: 'dependency' as const },
      { path: 'logo.png', reason: 'binary' as const },
    ];
    const out = build({ 'src/a.ts': 'export {};\n' }, {}, skipped);
    expect(out.omissions.filter((o) => o.reason !== 'budget')).toEqual([
      { path: 'logo.png', reason: 'binary' },
      { path: 'node_modules/x/index.js', reason: 'dependency' },
    ]);
  });
});

describe('redaction', () => {
  const secrets: Files = {
    'src/config.ts': [
      `const gh = '${GITHUB_TOKEN}';`,
      `const aws = "${AWS_KEY}";`,
      'const db = "postgres://admin:s3cr3tpass@db.internal/app";',
      'const password = "hunter2hunter2";',
      'export const apiKey = \'unclosed-value-to-eol',
    ].join('\r\n'),
    'src/key.ts': [
      `const key = \`-----BEGIN RSA PRIVATE KEY-----${PEM_BODY}`,
      PEM_BODY,
      `${PEM_BODY}-----END RSA PRIVATE KEY-----\`;`,
      'export default key;',
    ].join('\n'),
    'src/open.ts': `-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n${PEM_BODY}\n`,
  };

  it('removes secret values while keeping lines, terminators and markers', () => {
    const out = build(secrets);
    const json = JSON.stringify(out);
    for (const secret of [GITHUB_TOKEN, AWS_KEY, 's3cr3tpass', 'hunter2hunter2', 'unclosed-value', PEM_BODY]) {
      expect(json).not.toContain(secret);
    }

    const config = out.chunks.find((c) => c.path === 'src/config.ts')!;
    expect(config.text.split('\r\n')).toEqual([
      "const gh = '[REDACTED:github_token]';",
      'const aws = "[REDACTED:aws_key]";',
      'const db = "postgres://admin:[REDACTED:url_password]@db.internal/app";',
      'const password = "[REDACTED:assignment]";',
      "export const apiKey = '[REDACTED:assignment]",
    ]);
    expect(config.sha256).toBe(sha(secrets['src/config.ts']!));

    const key = out.chunks.find((c) => c.path === 'src/key.ts')!;
    expect(key.text).toBe(
      [
        'const key = `-----BEGIN RSA PRIVATE KEY-----[REDACTED:private_key]',
        '[REDACTED:private_key]',
        '[REDACTED:private_key]-----END RSA PRIVATE KEY-----`;',
        'export default key;',
      ].join('\n'),
    );
    expect(key.redactions).toEqual([1, 2, 3].map((line) => ({ line, kind: 'private_key' })));

    const open = out.chunks.find((c) => c.path === 'src/open.ts')!;
    expect(open.text).toBe('-----BEGIN PRIVATE KEY-----\n[REDACTED:private_key]\n[REDACTED:private_key]\n');
  });

  it('only closes a PEM block on the END marker with the same label', () => {
    const text = `-----BEGIN EC PRIVATE KEY-----\n-----END RSA PRIVATE KEY-----\n${PEM_BODY}\n`;
    expect(redactString(text)).not.toContain(PEM_BODY);
  });
});

describe('manifests', () => {
  it('summarizes compact package.json with exact lines, sections and script names', () => {
    const manifest = '{"name":"demo","dependencies":{"zod":"^3.25.0"},"devDependencies":{"zod":"^3.24.0"}}';
    const out = build({
      'package.json': manifest,
      'apps/web/package.json': [
        '{',
        '  "name": "web",',
        '  "scripts": { "10": "vite", "postinstall": "node -e \\"process.exit(1)\\"" },',
        '  "dependencies": {',
        '    "react": "^19.0.0",',
        '    "1": "^1.0.0"',
        '  }',
        '}',
      ].join('\n'),
    });
    expect(out.manifests).toEqual([
      {
        path: 'apps/web/package.json',
        ecosystem: 'npm',
        name: 'web',
        scripts: ['10', 'postinstall'],
        dependencies: [
          { name: 'react', section: 'dependencies', spec: '^19.0.0', line: 5 },
          { name: '1', section: 'dependencies', spec: '^1.0.0', line: 6 },
        ],
      },
      {
        path: 'package.json',
        ecosystem: 'npm',
        name: 'demo',
        dependencies: [
          { name: 'zod', section: 'dependencies', spec: '^3.25.0', line: 1 },
          { name: 'zod', section: 'devDependencies', spec: '^3.24.0', line: 1 },
        ],
      },
    ]);
    expect(JSON.stringify(out)).not.toContain('process.exit');
    expect(out.chunks).toEqual([]);
  });

  it('keeps a dependency name containing an escaped NUL intact', () => {
    const out = buildPackets(
      {
        commitSha: 'fixture',
        files: [{ path: 'package.json', content: '{"dependencies":{"foo\\u0000bar":"1"}}' }],
        skipped: [],
      },
      { owner: 'fixture', repo: 'review' },
    );
    expect(out.manifests[0]!.dependencies).toEqual([
      { name: 'foo\u0000bar', section: 'dependencies', spec: '1', line: 1 },
    ]);
  });

  it('summarizes requirements and simple go.mod files', () => {
    const out = build({
      'requirements.txt': '# web\nDjango[argon2]>=5.0,<6 ; python_version >= "3.10"\nrequests  # http\n',
      'go.mod': [
        'module example.com/app',
        'go 1.22',
        'toolchain go1.22.1',
        'require github.com/a/b v1.2.3',
        'require (',
        '\tgithub.com/c/d v0.1.0 // indirect',
        '\tgithub.com/e/f v2.0.0',
        ')',
      ].join('\n'),
    });
    expect(out.manifests).toEqual([
      {
        path: 'go.mod',
        ecosystem: 'go',
        name: 'example.com/app',
        dependencies: [
          { name: 'github.com/a/b', section: 'require', spec: 'v1.2.3', line: 4 },
          { name: 'github.com/c/d', section: 'indirect', spec: 'v0.1.0', line: 6 },
          { name: 'github.com/e/f', section: 'require', spec: 'v2.0.0', line: 7 },
        ],
      },
      {
        path: 'requirements.txt',
        ecosystem: 'requirements',
        dependencies: [
          { name: 'Django', section: 'requirements', spec: '[argon2]>=5.0,<6 ; python_version >= "3.10"', line: 2 },
          { name: 'requests', section: 'requirements', spec: '', line: 3 },
        ],
      },
    ]);
  });

  it.each([
    ['pyproject.toml', '[project]\nname = "x"\ndependencies = ["requests"]\n'],
    ['Cargo.toml', '[dependencies]\nserde = { version = "1", features = ["derive"] }\n'],
    ['go.mod', 'module x\nrequire a v1\nreplace a => ../a\n'],
    ['requirements.txt', 'requests\n-r other.txt\n'],
    ['package.json', '{"dependencies": ["not", "an", "object"]}'],
    ['package.json', '[]'],
    ['package.json', '{"name": "a", "name": "b"}'],
    ['package.json', '{"dependencies": {"a": "1"}, "overrides": {}}'],
    ['package.json', '{"scripts": {"build": null}}'],
    ['package.json', '{"broken": '],
  ])('chunks unsupported or invalid %s instead of summarizing it', (path, content) => {
    const out = build({ [path]: content });
    expect(out.manifests).toEqual([]);
    expect(status(out, path)).toBe('included');
    expect(packet(out, 'repository')!.primary).toEqual([`${path}#L1-L${splitLines(content).length}`]);
  });

  it('redacts secrets that only appear after decoding JSON escapes', () => {
    const escaped = `\\u0067${GITHUB_TOKEN.slice(1)}`;
    const pem = `\\u002d----BEGIN PRIVATE KEY-----\\n${PEM_BODY}\\n-----END PRIVATE KEY-----`;
    const out = build({
      'package.json': `{"name": "${escaped}", "scripts": {"${escaped}": "x"},
        "dependencies": {"a": "${escaped}", "b": "${pem}"}}`,
    });
    const json = JSON.stringify(out);
    expect(json).not.toContain(GITHUB_TOKEN);
    expect(json).not.toContain(PEM_BODY);
    const [summary] = out.manifests;
    expect(summary!.name).toBe('[REDACTED:github_token]');
    expect(summary!.scripts).toEqual(['[REDACTED:github_token]']);
    expect(summary!.dependencies.map((d) => d.spec)).toEqual([
      '[REDACTED:github_token]',
      '-----BEGIN PRIVATE KEY-----\n[REDACTED:private_key]\n-----END PRIVATE KEY-----',
    ]);
  });
});

describe('links and pairing', () => {
  it('resolves JS imports with extension swaps and index files', () => {
    const out = build({
      'src/a.ts': "import { b } from './b.js';\nimport './lib';\nconst c = require('../c');\n",
      'src/b.ts': 'export const b = 1;\n',
      'src/lib/index.tsx': 'export {};\n',
      'c.js': 'module.exports = 1;\n',
      'src/escape.ts': "import x from '../../outside';\n",
    });
    expect(chunkPaths(out, packet(out, 'p:src/a.ts')!.context)).toEqual([
      'c.js',
      'src/b.ts',
      'src/lib/index.tsx',
    ]);
    expect(packet(out, 'p:src/escape.ts')!.context).toEqual([]);
  });

  it('resolves only the supported Python relative-import grammar', () => {
    const out = build({
      'pkg/sub/mod.py': [
        'from .. import a, b as c',
        'from .foo.bar import x',
        'from . import (',
        'from ...... import deep',
      ].join('\n'),
      'pkg/a.py': 'A = 1\n',
      'pkg/b/__init__.py': 'B = 1\n',
      'pkg/c.py': 'C = 1\n',
      'pkg/sub/foo/bar.py': 'X = 1\n',
      'pkg/sub/(.py': 'odd = 1\n',
      'deep.py': 'D = 1\n',
    });
    expect(chunkPaths(out, packet(out, 'p:pkg/sub/mod.py')!.context).sort()).toEqual([
      'pkg/a.py',
      'pkg/b/__init__.py',
      'pkg/sub/foo/bar.py',
    ]);
  });

  it('pairs tests by import, then by a unique stem, and never guesses', () => {
    const out = build({
      'src/foo.ts': 'export const foo = 1;\n',
      'src/__tests__/unit/foo.test.ts': "test('foo', () => {});\n",
      'src/bar.ts': 'export {};\n',
      'src/bar.tsx': 'export {};\n',
      'src/bar.test.ts': "test('bar', () => {});\n",
      'pkg-a/baz.ts': 'export {};\n',
      'pkg-b/baz.test.ts': "test('baz', () => {});\n",
      'src/qux.ts': 'export {};\n',
      'tests/qux.spec.ts': "import { qux } from '../src/qux';\n",
      'tests/fixtures/data.ts': 'export const data = [];\n',
    });
    expect(chunkPaths(out, packet(out, 'p:src/foo.ts')!.tests)).toEqual([
      'src/__tests__/unit/foo.test.ts',
    ]);
    expect(chunkPaths(out, packet(out, 'p:src/qux.ts')!.tests)).toEqual(['tests/qux.spec.ts']);
    expect(status(out, 'src/bar.test.ts')).toBe('unpaired');
    expect(status(out, 'pkg-b/baz.test.ts')).toBe('unpaired');
    expect(status(out, 'tests/fixtures/data.ts')).toBe('unpaired');
  });

  it('ignores imports of excluded files for context and fan-in', () => {
    const out = build({
      'src/a.ts': "import './gen';\n",
      'src/b.ts': "import './gen';\n",
      'src/gen.ts': '// @generated\nexport {};\n',
    });
    expect(out.packets.map((p) => p.id)).toEqual(['p:src/a.ts', 'p:src/b.ts']);
    expect(out.packets.every((p) => p.context.length === 0)).toBe(true);
  });

  it('keeps identical files at different paths separate', () => {
    const body = "import { n } from './neighbour';\n";
    const out = build({
      'src/a.ts': body,
      'src/neighbour.ts': 'export const n = 1;\n',
      'lib/a.ts': body,
      'lib/neighbour.ts': 'export const n = 2;\n',
    });
    expect(chunkPaths(out, packet(out, 'p:src/a.ts')!.context)).toEqual(['src/neighbour.ts']);
    expect(chunkPaths(out, packet(out, 'p:lib/a.ts')!.context)).toEqual(['lib/neighbour.ts']);
  });

  it('resolves imports of the repository root but not above it', () => {
    const out = build({
      'index.ts': 'export const x = 1;',
      'src/app.ts': "import { x } from '../';",
      'main.ts': "import { x } from './';",
      'src/escape.ts': "import { x } from '../../';",
    });
    expect(chunkPaths(out, packet(out, 'p:src/app.ts')!.context)).toEqual(['index.ts']);
    expect(chunkPaths(out, packet(out, 'p:main.ts')!.context)).toEqual(['index.ts']);
    expect(packet(out, 'p:src/escape.ts')!.context).toEqual([]);
    // Two importers give index.ts the highest fan-in, so its packet comes first.
    expect(out.packets[0]!.id).toBe('p:index.ts');
  });
});

describe('ranking', () => {
  const files: Files = {
    'src/a.ts': "import './hub';\nimport './z';\n",
    'src/b.ts': "import './hub';\n",
    'src/hub.ts': "import './z';\n",
    'src/z.ts': 'export {};\n',
    'src/a.test.ts': "import './a';\n",
  };

  it('orders packets by fan-in, then path, with context ranked by fan-in', () => {
    const out = build(files);
    expect(out.packets.map((p) => p.id)).toEqual([
      'p:src/hub.ts',
      'p:src/z.ts',
      'p:src/a.ts',
      'p:src/b.ts',
    ]);
    expect(chunkPaths(out, packet(out, 'p:src/a.ts')!.context)).toEqual(['src/hub.ts', 'src/z.ts']);
    expect(chunkPaths(out, packet(out, 'p:src/a.ts')!.tests)).toEqual(['src/a.test.ts']);
  });

  it('puts focused packets first in supplied order and records ignored entries', () => {
    const out = build(
      { ...files, 'README.md': '# x\n' },
      { focusPaths: ['src/b.ts', 'missing.ts', 'src/a.ts', 'src/b.ts', 'README.md'], maxContextFiles: 1 },
    );
    expect(out.packets.map((p) => p.id).slice(0, 3)).toEqual(['p:src/b.ts', 'p:src/a.ts', 'p:src/hub.ts']);
    expect(out.ignoredFocusPaths).toEqual([
      { path: 'missing.ts', reason: 'unknown' },
      { path: 'src/b.ts', reason: 'repeat' },
      { path: 'README.md', reason: 'not_source' },
    ]);
    // Context order is fan-in based, not focus based.
    expect(chunkPaths(out, packet(out, 'p:src/a.ts')!.context)).toEqual(['src/hub.ts']);
  });

  it('never lists a chunk twice in one packet', () => {
    const out = build({ 'src/a.ts': "import './a';\nimport './a.js';\n" });
    const ids = Object.values(packet(out, 'p:src/a.ts')!).flat().filter((v) => typeof v === 'string');
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('budget', () => {
  it('drops a packet without primary evidence before allocating its tests or context', () => {
    const out = build(
      {
        'src/big.ts': `import { small } from './small';\n${lines(50, 'const big =')}`,
        'src/big.test.ts': "import { big } from './big';\n",
        'src/small.ts': 'export const small = 1;\n',
      },
      { focusPaths: ['src/big.ts'], maxCharsPerPacket: 200 },
    );
    expect(packet(out, 'p:src/big.ts')).toBeUndefined();
    expect(out.chunks.some((c) => c.path === 'src/big.test.ts')).toBe(false);
    expect(status(out, 'src/big.test.ts')).toBe('excluded_budget');
    expect(out.usedChars).toBe(out.packets.reduce((sum, p) => sum + p.size, 0));
    expect(chunkPaths(out, packet(out, 'p:src/small.ts')!.primary)).toEqual(['src/small.ts']);
    expectCoverage(out);
  });

  it('charges shared chunks once globally but in every packet size', () => {
    const shared = 'export const shared = 1;\n';
    const out = build({
      'src/a.ts': "import './shared';\n",
      'src/b.ts': "import './shared';\n",
      'src/shared.ts': shared,
    });
    const total = out.chunks.reduce((sum, c) => sum + c.text.length, 0);
    expect(out.usedChars).toBe(total);
    expect(packet(out, 'p:src/a.ts')!.size).toBe("import './shared';\n".length + shared.length);
    const referenced = new Set(out.packets.flatMap((p) => [...p.primary, ...p.tests, ...p.context]));
    expect([...referenced].sort()).toEqual(out.chunks.map((c) => c.id).sort());
  });

  it('records partial files, rejected summaries and budget ranges consistently', () => {
    const out = build(
      {
        'package.json': '{"dependencies": {"zod": "^3.25.0"}}',
        'src/long.ts': lines(30),
        'src/other.ts': lines(5),
      },
      { maxChars: 100, chunkLines: 10 },
    );
    expect(status(out, 'package.json')).toBe('summary_excluded');
    expect(out.manifests).toEqual([]);
    expect(out.usedChars).toBeLessThanOrEqual(100);
    expect(out.packets.every((p) => p.size <= DEFAULT_PACKET_OPTIONS.maxCharsPerPacket)).toBe(true);
    const emitted = new Set(out.chunks.map((c) => c.id));
    for (const o of out.omissions) {
      if (o.reason === 'budget') expect(emitted.has(`${o.path}#L${o.startLine}-L${o.endLine}`)).toBe(false);
    }
    expectCoverage(out);
  });

  it('emits nothing at maxChars 0', () => {
    const out = build({ 'src/a.ts': 'export {};\n', 'README.md': '# x\n' }, { maxChars: 0 });
    expect(out.chunks).toEqual([]);
    expect(out.packets).toEqual([]);
    expect(out.usedChars).toBe(0);
    expect(out.omissions).toEqual([
      { path: 'README.md', reason: 'budget', startLine: 1, endLine: 1 },
      { path: 'src/a.ts', reason: 'budget', startLine: 1, endLine: 1 },
    ]);
    expectCoverage(out);
  });
});

describe('determinism and safety', () => {
  const files: Files = {
    'src/a.ts': "import './b';\n",
    'src/b.ts': 'export {};\n',
    'src/b.test.ts': "import './b';\n",
    'package.json': '{"name":"x","dependencies":{"a":"1"}}',
    'docs/guide.md': '# Guide\n',
  };
  const skipped = [
    { path: 'z.png', reason: 'binary' as const },
    { path: 'a.lock', reason: 'lockfile' as const },
  ];

  it('produces byte-identical output for shuffled input and never mutates it', () => {
    const forward = snap(files, skipped);
    const reversed: RepoSnapshot = {
      ...forward,
      files: [...forward.files].reverse(),
      skipped: [...skipped].reverse(),
    };
    const deepFreeze = <T>(value: T): T => {
      if (value && typeof value === 'object') {
        Object.values(value).forEach(deepFreeze);
        Object.freeze(value);
      }
      return value;
    };
    const before = structuredClone(reversed);
    const frozen = deepFreeze(reversed);
    const a = JSON.stringify(buildPackets(forward, repo));
    const b = JSON.stringify(buildPackets(frozen, repo));
    expect(b).toBe(a);
    expect(frozen).toEqual(before);
  });

  it('treats repository code as inert text', () => {
    const hostile = "process.exit(1);\nrequire('child_process').execSync('rm -rf /');\n";
    const out = build({
      'src/run.ts': hostile,
      'package.json': '{"scripts": {"postinstall": "node -e \\"process.exit(1)\\""}}',
    });
    expect(out.chunks.find((c) => c.path === 'src/run.ts')!.text).toBe(hostile);
    expect(out.manifests[0]!.scripts).toEqual(['postinstall']);
  });
});
