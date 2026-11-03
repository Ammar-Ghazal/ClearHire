// Turns a filtered RepoSnapshot into bounded analysis packets for later model calls. Pure and
// synchronous: repository text is only split, regex-matched and JSON.parse'd, never executed.
import { createHash } from 'node:crypto';
import type { SkipReason } from './ingest-filter.js';
import type { RepoSnapshot } from './ingest.js';

export const CLEANER_VERSION = 1;

export interface PacketOptions {
  maxChars: number;
  maxCharsPerPacket: number;
  chunkLines: number;
  maxContextFiles: number;
  focusPaths: string[];
}

export const DEFAULT_PACKET_OPTIONS: PacketOptions = {
  maxChars: 120_000,
  maxCharsPerPacket: 24_000,
  chunkLines: 120,
  maxContextFiles: 4,
  focusPaths: [],
};

export type FileKind = 'manifest' | 'test' | 'ci' | 'doc' | 'source';

/** `included`/`partial`/`excluded_budget` apply to chunk-eligible files; the rest are whole-file. */
export type FileStatus =
  | 'included'
  | 'partial'
  | 'excluded_budget'
  | 'summarized'
  | 'summary_excluded'
  | 'empty'
  | 'long_line'
  | 'generated';

export type RedactionKind =
  | 'private_key'
  | 'github_token'
  | 'aws_key'
  | 'slack_token'
  | 'api_key'
  | 'jwt'
  | 'url_password'
  | 'assignment';

export interface FileRecord {
  path: string;
  kind: FileKind;
  status: FileStatus;
  sha256: string;
  lineCount: number;
}

export interface Chunk {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  /** SHA-256 of the original, unredacted range including line terminators. */
  sha256: string;
  text: string;
  redactions: { line: number; kind: RedactionKind }[];
}

export interface Packet {
  id: string;
  primary: string[];
  tests: string[];
  context: string[];
  size: number;
}

export interface ManifestSummary {
  path: string;
  ecosystem: 'npm' | 'requirements' | 'go';
  name?: string;
  scripts?: string[];
  dependencies: { name: string; section: string; spec: string; line: number }[];
}

export type Omission =
  | { path: string; reason: SkipReason }
  | { path: string; reason: 'budget'; startLine: number; endLine: number };

export interface AnalysisPackets {
  repository: { owner: string; repo: string };
  commitSha: string;
  cleanerVersion: typeof CLEANER_VERSION;
  options: PacketOptions;
  files: FileRecord[];
  manifests: ManifestSummary[];
  chunks: Chunk[];
  packets: Packet[];
  omissions: Omission[];
  usedChars: number;
  ignoredFocusPaths: { path: string; reason: 'unknown' | 'not_source' | 'repeat' }[];
}

// ---- Options ----

const INTEGER_RANGES = {
  maxChars: [0, Number.MAX_SAFE_INTEGER],
  maxCharsPerPacket: [0, Number.MAX_SAFE_INTEGER],
  chunkLines: [1, 1000],
  maxContextFiles: [0, 20],
} as const;
const MAX_FOCUS_PATH_LENGTH = 512;

/** Validates options against the defaults. Errors name the offending key, never its value. */
export function resolveOptions(input: Partial<PacketOptions> = {}): PacketOptions {
  const invalid = (key: string) => new RangeError(`Invalid packet option: ${key}`);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw invalid('options');

  const resolved: PacketOptions = { ...DEFAULT_PACKET_OPTIONS, focusPaths: [] };
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (key === 'focusPaths') {
      const valid =
        Array.isArray(value) &&
        value.every((p) => typeof p === 'string' && p.length <= MAX_FOCUS_PATH_LENGTH);
      if (!valid) throw invalid(key);
      resolved.focusPaths = [...value];
    } else if (Object.hasOwn(INTEGER_RANGES, key)) {
      const [min, max] = INTEGER_RANGES[key as keyof typeof INTEGER_RANGES];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
        throw invalid(key);
      }
      resolved[key as keyof typeof INTEGER_RANGES] = value;
    } else {
      throw invalid(key);
    }
  }
  return resolved;
}

// ---- Lines and hashes ----

interface Line {
  text: string;
  /** '\r\n', '\n', '\r', or '' for a final line without a terminator. */
  eol: string;
}

/** `\r\n`, `\n` and a lone `\r` each end a line; a final terminator does not start another. */
export function splitLines(content: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (const match of content.matchAll(/\r\n|\n|\r/g)) {
    lines.push({ text: content.slice(start, match.index), eol: match[0] });
    start = match.index + match[0].length;
  }
  if (start < content.length) lines.push({ text: content.slice(start), eol: '' });
  return lines;
}

const joinLines = (lines: Line[]) => lines.map((l) => l.text + l.eol).join('');
export const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ---- Classification ----

const MANIFEST_NAMES = new Set(['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml']);
const REQUIREMENTS_NAME = /^requirements([-_.][\w-]+)?\.txt$/;
const TEST_DIRS = new Set(['__tests__', 'test', 'tests', 'spec']);
const TEST_MARKERS = [/^(.+)\.(?:test|spec)\.[^.]+$/, /^test_(.+)\.py$/, /^(.+)_test\.py$/, /^(.+)_test\.go$/];
const DOC_NAME = /\.(?:md|mdx|rst|txt)$/;
const MAX_LINE_LENGTH = 1000;

type Exclusion = 'empty' | 'long_line' | 'generated';

/** The name X a test file is about (`X.test.ts`, `test_X.py`, ...), or null for other names. */
function testStem(name: string): string | null {
  for (const marker of TEST_MARKERS) {
    const match = marker.exec(name);
    if (match) return match[1]!;
  }
  return null;
}

function classify(dirs: string[], name: string): FileKind {
  if (MANIFEST_NAMES.has(name) || REQUIREMENTS_NAME.test(name)) return 'manifest';
  if (dirs.some((d) => TEST_DIRS.has(d)) || testStem(name) !== null) return 'test';
  if (dirs.length === 2 && dirs[0] === '.github' && dirs[1] === 'workflows' && /\.ya?ml$/.test(name)) {
    return 'ci';
  }
  if (DOC_NAME.test(name) || dirs[0] === 'docs') return 'doc';
  return 'source';
}

function exclusionOf(name: string, lines: Line[]): Exclusion | null {
  if (lines.length === 0) return 'empty';
  if (lines.some((l) => l.text.length > MAX_LINE_LENGTH)) return 'long_line';
  const marked = lines
    .slice(0, 5)
    .some((l) => l.text.includes('@generated') || l.text.includes('DO NOT EDIT'));
  if (name.includes('.min.') || marked) return 'generated';
  return null;
}

// ---- Redaction ----
// Heuristic: unquoted assignment values and secrets hidden behind escapes in chunk text are missed.

interface TokenRule {
  kind: RedactionKind;
  pattern: RegExp;
  /** Capture group holding the secret; the whole match when omitted. */
  group?: number;
  minLength?: number;
}

const ASSIGNMENT_KEY = String.raw`(["']?)(?<![\w.-])([\w.-]*?(?:password|passwd|secret|token|api_?key|private_?key)[\w.-]*)\1\s*[:=]\s*`;
const QUOTED_VALUE = String.raw`(["'])((?:\\.|(?!\3)[^\\])*)`;

// Listed in priority order, which breaks ties between overlapping matches.
const TOKEN_RULES: TokenRule[] = [
  { kind: 'github_token', pattern: /(?<!\w)(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_\w{22,})(?!\w)/dg },
  { kind: 'aws_key', pattern: /(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/dg },
  { kind: 'slack_token', pattern: /xox[abprs]-[A-Za-z0-9-]{10,}/dg },
  { kind: 'api_key', pattern: /sk-[\w-]{20,}/dg },
  { kind: 'jwt', pattern: /eyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/dg },
  { kind: 'url_password', pattern: /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]+)@/dg, group: 1 },
  {
    kind: 'assignment',
    pattern: new RegExp(`${ASSIGNMENT_KEY}${QUOTED_VALUE}\\3`, 'dgi'),
    group: 4,
    minLength: 8,
  },
  // An unclosed quote is redacted to the end of the line.
  { kind: 'assignment', pattern: new RegExp(`${ASSIGNMENT_KEY}${QUOTED_VALUE}$`, 'dgi'), group: 4 },
];

const PEM_BEGIN = /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY-----/g;

interface Span {
  start: number;
  end: number;
  kind: RedactionKind;
  priority: number;
}

interface LineRedaction {
  line: number;
  kind: RedactionKind;
  /** Match start within the line; used only for ordering, never emitted. */
  start: number;
}

/** Collects PEM spans for one line, advancing the open-block label across lines. */
function pemSpans(text: string, openLabel: string | null): { spans: Span[]; openLabel: string | null } {
  const spans: Span[] = [];
  let label = openLabel;
  let pos = 0;
  while (pos <= text.length) {
    if (label !== null) {
      const end = `-----END ${label}PRIVATE KEY-----`;
      const at = text.indexOf(end, pos);
      if (at === -1) {
        if (pos < text.length) spans.push({ start: pos, end: text.length, kind: 'private_key', priority: -1 });
        break;
      }
      if (at > pos) spans.push({ start: pos, end: at, kind: 'private_key', priority: -1 });
      pos = at + end.length;
      label = null;
    } else {
      PEM_BEGIN.lastIndex = pos;
      const begin = PEM_BEGIN.exec(text);
      if (!begin) break;
      label = begin[1]!;
      pos = begin.index + begin[0].length;
    }
  }
  return { spans, openLabel: label };
}

function tokenSpans(text: string): Span[] {
  const spans: Span[] = [];
  TOKEN_RULES.forEach((rule, priority) => {
    for (const match of text.matchAll(rule.pattern)) {
      const range = match.indices?.[rule.group ?? 0];
      if (!range || range[1] - range[0] < (rule.minLength ?? 1)) continue;
      spans.push({ start: range[0], end: range[1], kind: rule.kind, priority });
    }
  });
  return spans;
}

/** Replaces secret spans with `[REDACTED:<kind>]`, keeping line count and terminators. */
function redactLines(lines: Line[]): { lines: Line[]; redactions: LineRedaction[] } {
  const out: Line[] = [];
  const redactions: LineRedaction[] = [];
  let openLabel: string | null = null;

  lines.forEach((line, index) => {
    const pem = pemSpans(line.text, openLabel);
    openLabel = pem.openLabel;
    const candidates = [...pem.spans, ...tokenSpans(line.text)].sort(
      (a, b) => a.start - b.start || b.end - a.end || a.priority - b.priority,
    );
    const kept: Span[] = [];
    for (const span of candidates) {
      if (kept.length === 0 || span.start >= kept.at(-1)!.end) kept.push(span);
    }

    let text = '';
    let pos = 0;
    let pemRecorded = false;
    for (const span of kept) {
      text += `${line.text.slice(pos, span.start)}[REDACTED:${span.kind}]`;
      pos = span.end;
      // A PEM block gets one record per affected line.
      if (span.kind === 'private_key' && pemRecorded) continue;
      pemRecorded ||= span.kind === 'private_key';
      redactions.push({ line: index + 1, kind: span.kind, start: span.start });
    }
    out.push({ text: text + line.text.slice(pos), eol: line.eol });
  });
  return { lines: out, redactions };
}

/** Redacts an arbitrary string with the same PEM-aware rules, e.g. a decoded manifest value. */
export function redactString(value: string): string {
  return joinLines(redactLines(splitLines(value)).lines);
}

// ---- Manifest summaries ----

type Summary = Omit<ManifestSummary, 'path'>;
type Dependency = ManifestSummary['dependencies'][number];

const NPM_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const NPM_UNSUPPORTED = ['overrides', 'resolutions', 'pnpm'];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isStringMap = (value: unknown): value is Record<string, string> =>
  isPlainObject(value) && Object.values(value).every((v) => typeof v === 'string');

interface JsonFrame {
  isObject: boolean;
  expectKey: boolean;
  /** Root key this frame is the value of, for depth-2 objects. */
  parent: string | null;
  keys: Set<string>;
  lastKey: string | null;
}

interface JsonKey {
  parent: string;
  key: string;
  line: number;
}

/**
 * Lists depth-2 keys of already-parsed JSON with their root key and line, in file order. Returns
 * null on a duplicate key at depth 1 or 2.
 */
function scanJsonKeys(json: string): JsonKey[] | null {
  const keys: JsonKey[] = [];
  const stack: JsonFrame[] = [];
  let line = 1;

  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (ch === '\n' || (ch === '\r' && json[i + 1] !== '\n')) {
      line++;
    } else if (ch === '"') {
      let end = i + 1;
      while (end < json.length && json[end] !== '"') end += json[end] === '\\' ? 2 : 1;
      const top = stack.at(-1);
      if (top?.isObject && top.expectKey) {
        const key = JSON.parse(json.slice(i, end + 1)) as string;
        if (stack.length <= 2) {
          if (top.keys.has(key)) return null;
          top.keys.add(key);
          if (stack.length === 2 && top.parent !== null) keys.push({ parent: top.parent, key, line });
        }
        top.expectKey = false;
        top.lastKey = key;
      }
      i = end;
    } else if (ch === '{' || ch === '[') {
      const top = stack.at(-1);
      const parent = stack.length === 1 && top?.isObject ? top.lastKey : null;
      stack.push({ isObject: ch === '{', expectKey: ch === '{', parent, keys: new Set(), lastKey: null });
    } else if (ch === '}' || ch === ']') {
      stack.pop();
    } else if (ch === ',') {
      const top = stack.at(-1);
      if (top?.isObject) top.expectKey = true;
    }
  }
  return keys;
}

function summarizeNpm(text: string): Summary | null {
  const json = text.startsWith('﻿') ? text.slice(1) : text;
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isPlainObject(root) || NPM_UNSUPPORTED.some((key) => Object.hasOwn(root, key))) return null;
  if (Object.hasOwn(root, 'name') && typeof root.name !== 'string') return null;
  for (const key of [...NPM_SECTIONS, 'scripts']) {
    if (Object.hasOwn(root, key) && !isStringMap(root[key])) return null;
  }
  const keys = scanJsonKeys(json);
  if (!keys) return null;

  // Walk keys in file order; Object.entries would move integer-like names first.
  const dependencies: Dependency[] = [];
  const scripts: string[] = [];
  for (const { parent, key, line } of keys) {
    if (NPM_SECTIONS.includes(parent)) {
      const spec = (root[parent] as Record<string, string>)[key]!;
      dependencies.push({ name: key, section: parent, spec, line });
    } else if (parent === 'scripts') {
      scripts.push(key);
    }
  }
  return {
    ecosystem: 'npm',
    ...(typeof root.name === 'string' && { name: root.name }),
    ...(Object.hasOwn(root, 'scripts') && { scripts }),
    dependencies,
  };
}

const REQUIREMENT = /^([A-Za-z0-9][\w.-]*)(\[[\w,. -]*\])?\s*([<>=!~]=?=?[^;]*)?(;.*)?$/;

function summarizeRequirements(lines: Line[]): Summary | null {
  const dependencies: Dependency[] = [];
  for (const [index, line] of lines.entries()) {
    const text = line.text.replace(/(^|\s)#.*$/, '').trim();
    if (text === '') continue;
    const match = REQUIREMENT.exec(text);
    if (!match) return null;
    const name = match[1]!;
    dependencies.push({
      name,
      section: 'requirements',
      spec: text.slice(name.length).trim(),
      line: index + 1,
    });
  }
  return { ecosystem: 'requirements', dependencies };
}

function summarizeGoMod(lines: Line[]): Summary | null {
  const dependencies: Dependency[] = [];
  let name: string | undefined;
  let inRequireBlock = false;

  const requireEntry = (tokens: string[], indirect: boolean, line: number) => {
    const [path, version] = tokens;
    if (tokens.length !== 2 || /["`]/.test(path! + version!)) return false;
    dependencies.push({ name: path!, section: indirect ? 'indirect' : 'require', spec: version!, line });
    return true;
  };

  for (const [index, line] of lines.entries()) {
    let text = line.text;
    let indirect = false;
    const comment = text.indexOf('//');
    if (comment !== -1) {
      indirect = text.slice(comment + 2).trim() === 'indirect';
      text = text.slice(0, comment);
    }
    const tokens = text.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;

    if (inRequireBlock) {
      if (tokens.length === 1 && tokens[0] === ')') inRequireBlock = false;
      else if (!requireEntry(tokens, indirect, index + 1)) return null;
      continue;
    }
    const [keyword, ...args] = tokens;
    if (keyword === 'module' && args.length === 1 && name === undefined && !/["`]/.test(args[0]!)) {
      name = args[0];
    } else if ((keyword === 'go' || keyword === 'toolchain') && args.length === 1) {
      // Language and toolchain versions don't change the dependency set.
    } else if (keyword === 'require' && args.length === 1 && args[0] === '(') {
      inRequireBlock = true;
    } else if (keyword !== 'require' || !requireEntry(args, indirect, index + 1)) {
      // replace, exclude, retract, godebug and anything unrecognized fall back to chunks.
      return null;
    }
  }
  if (inRequireBlock) return null;
  return { ecosystem: 'go', ...(name !== undefined && { name }), dependencies };
}

/** Summarizes redacted manifest lines, or returns null so the file is chunked instead. */
function summarizeManifest(path: string, name: string, lines: Line[]): ManifestSummary | null {
  let summary: Summary | null = null;
  if (name === 'package.json') summary = summarizeNpm(joinLines(lines));
  else if (name === 'go.mod') summary = summarizeGoMod(lines);
  else if (REQUIREMENTS_NAME.test(name)) summary = summarizeRequirements(lines);
  if (!summary) return null;

  // Decoding can reveal secrets that the line pass couldn't see, so redact every emitted string.
  return {
    path,
    ecosystem: summary.ecosystem,
    ...(summary.name !== undefined && { name: redactString(summary.name) }),
    ...(summary.scripts && { scripts: summary.scripts.map(redactString) }),
    dependencies: summary.dependencies.map((d) => ({
      name: redactString(d.name),
      section: redactString(d.section),
      spec: redactString(d.spec),
      line: d.line,
    })),
  };
}

// ---- Imports and test pairing ----

const JS_IMPORT = /\b(?:from|import|require)\s*\(?\s*(['"])(\.\.?\/[^'"]*)\1/g;
const JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const JS_SWAPS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};
const PY_FROM_IMPORT = /^\s*from\s+(\.+)([\w.]*)\s+import\s+(.+?)\s*$/;
const PY_NAMES = /^(?:\*|\w+(?:\s+as\s+\w+)?(?:\s*,\s*\w+(?:\s+as\s+\w+)?)*)$/;

/**
 * Joins relative segments onto a directory. The repository root is `''`; null means the segments
 * climb above it.
 */
function joinPath(dirs: string[], relative: string[]): string | null {
  const out = [...dirs];
  for (const segment of relative) {
    if (segment === '' || segment === '.') continue;
    if (segment !== '..') out.push(segment);
    else if (out.pop() === undefined) return null;
  }
  return out.join('/');
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}

function jsCandidates(target: string): string[] {
  // The root directory itself can only resolve to a root index file.
  if (target === '') return JS_EXTENSIONS.map((e) => `index${e}`);
  const ext = extensionOf(target);
  const swaps = (JS_SWAPS[ext] ?? []).map((s) => target.slice(0, -ext.length) + s);
  return [
    target,
    ...swaps,
    ...JS_EXTENSIONS.map((e) => target + e),
    ...JS_EXTENSIONS.map((e) => `${target}/index${e}`),
  ];
}

/** Candidate path lists for each supported relative import on one line. */
function importCandidates(isPython: boolean, dirs: string[], text: string): string[][] {
  if (!isPython) {
    const found: string[][] = [];
    for (const match of text.matchAll(JS_IMPORT)) {
      const target = joinPath(dirs, match[2]!.split('/'));
      if (target !== null) found.push(jsCandidates(target));
    }
    return found;
  }

  const match = PY_FROM_IMPORT.exec(text);
  if (!match || !PY_NAMES.test(match[3]!)) return [];
  const ups = match[1]!.length - 1;
  if (ups > dirs.length) return [];
  const base = dirs.slice(0, dirs.length - ups);
  const module = match[2]!;
  const resolve = (segments: string[]) => {
    const path = joinPath(base, segments);
    return path === null || path === '' ? [] : [[`${path}.py`, `${path}/__init__.py`]];
  };

  if (module !== '') {
    const segments = module.split('.');
    return segments.includes('') ? [] : resolve(segments);
  }
  if (match[3] === '*') return [];
  // Resolve each originally imported name; `as` aliases are dropped.
  return match[3]!.split(',').flatMap((part) => resolve([part.trim().split(/\s+/)[0]!]));
}

/**
 * Context for files downloaded without the rest of their repository: dependency manifests, files
 * the given ones import (one hop, resolved against `treePaths`), and tests paired by name. Uses the
 * same resolution as buildPackets. Returns paths not already in `files`, sorted.
 */
export function contextPaths(
  files: { path: string; content: string }[],
  treePaths: readonly string[],
): string[] {
  const tree = new Set(treePaths);
  const have = new Set(files.map((f) => f.path));
  const out = new Set<string>();
  const split = (path: string) => {
    const dirs = path.split('/');
    return { dirs, name: dirs.pop()! };
  };
  for (const path of treePaths) {
    const { dirs, name } = split(path);
    if (classify(dirs, name) === 'manifest') out.add(path);
  }
  const stems = new Set<string>();
  for (const f of files) {
    const { dirs, name } = split(f.path);
    const kind = classify(dirs, name);
    if (kind !== 'source' && kind !== 'test') continue;
    if (kind === 'source') {
      const dot = name.lastIndexOf('.');
      stems.add(`${dirs.join('/')}\0${dot > 0 ? name.slice(0, dot) : name}`);
    }
    for (const line of splitLines(f.content)) {
      for (const candidates of importCandidates(name.endsWith('.py'), dirs, line.text)) {
        const hit = candidates.find((c) => tree.has(c));
        if (hit !== undefined) out.add(hit);
      }
    }
  }
  for (const path of treePaths) {
    const { dirs, name } = split(path);
    const stem = testStem(name);
    if (stem === null) continue;
    const lastTestDir = dirs.findLastIndex((d) => TEST_DIRS.has(d));
    const dir = (lastTestDir === -1 ? dirs : dirs.slice(0, lastTestDir)).join('/');
    if (stems.has(`${dir}\0${stem}`)) out.add(path);
  }
  return [...out].filter((p) => !have.has(p)).sort(byCodeUnit);
}

// ---- Assembly ----

interface FileState {
  path: string;
  dirs: string[];
  name: string;
  kind: FileKind;
  exclusion: Exclusion | null;
  sha256: string;
  original: Line[];
  redacted: Line[];
  redactions: LineRedaction[];
}

interface PlannedPacket {
  id: string;
  primary: string[];
  tests: string[];
  context: string[];
}

function prepareFile(file: { path: string; content: string }): FileState {
  const dirs = file.path.split('/');
  const name = dirs.pop()!;
  const original = splitLines(file.content);
  const exclusion = exclusionOf(name, original);
  const { lines: redacted, redactions } =
    exclusion === null ? redactLines(original) : { lines: [], redactions: [] };
  return {
    path: file.path,
    dirs,
    name,
    kind: classify(dirs, name),
    exclusion,
    sha256: sha256Hex(file.content),
    original,
    redacted,
    redactions,
  };
}

function chunkFile(file: FileState, chunkLines: number): Chunk[] {
  const chunks: Chunk[] = [];
  for (let start = 0; start < file.original.length; start += chunkLines) {
    const end = Math.min(start + chunkLines, file.original.length);
    chunks.push({
      id: `${file.path}#L${start + 1}-L${end}`,
      path: file.path,
      startLine: start + 1,
      endLine: end,
      sha256: sha256Hex(joinLines(file.original.slice(start, end))),
      text: joinLines(file.redacted.slice(start, end)),
      redactions: file.redactions
        .filter((r) => r.line > start && r.line <= end)
        .map(({ line, kind }) => ({ line, kind })),
    });
  }
  return chunks;
}

/** Builds the analysis packets for one snapshot. Never mutates its inputs. */
export function buildPackets(
  snapshot: RepoSnapshot,
  repository: { owner: string; repo: string },
  options: Partial<PacketOptions> = {},
): AnalysisPackets {
  const opts = resolveOptions(options);
  const files = [...snapshot.files]
    .sort((a, b) => byCodeUnit(a.path, b.path))
    .map(prepareFile);
  const fileByPath = new Map(files.map((f) => [f.path, f]));
  const isEligibleSource = (f: FileState | undefined) =>
    f !== undefined && f.kind === 'source' && f.exclusion === null;

  const summaries = new Map<string, ManifestSummary>();
  for (const f of files) {
    if (f.kind !== 'manifest' || f.exclusion !== null) continue;
    const summary = summarizeManifest(f.path, f.name, f.redacted);
    if (summary) summaries.set(f.path, summary);
  }

  // Import edges from eligible sources and tests to eligible sources only.
  const edges = new Map<string, string[]>();
  for (const f of files) {
    if (f.exclusion !== null || (f.kind !== 'source' && f.kind !== 'test')) continue;
    const isPython = f.name.endsWith('.py');
    const targets = new Set<string>();
    for (const line of f.redacted) {
      for (const candidates of importCandidates(isPython, f.dirs, line.text)) {
        const hit = candidates.find((c) => fileByPath.has(c));
        if (hit !== undefined && hit !== f.path && isEligibleSource(fileByPath.get(hit))) {
          targets.add(hit);
        }
      }
    }
    edges.set(f.path, [...targets].sort(byCodeUnit));
  }

  const sources = files.filter(isEligibleSource);
  const fanIn = new Map<string, number>(sources.map((s) => [s.path, 0]));
  for (const s of sources) {
    for (const target of edges.get(s.path)!) fanIn.set(target, fanIn.get(target)! + 1);
  }
  const byFanIn = (a: string, b: string) => fanIn.get(b)! - fanIn.get(a)! || byCodeUnit(a, b);

  // Pair tests by import first, then by a unique stem match.
  const sourcesByStem = new Map<string, string[]>();
  for (const s of sources) {
    const dot = s.name.lastIndexOf('.');
    const key = `${s.dirs.join('/')}\0${dot > 0 ? s.name.slice(0, dot) : s.name}`;
    sourcesByStem.set(key, [...(sourcesByStem.get(key) ?? []), s.path]);
  }
  const testsOf = new Map<string, string[]>();
  const unpaired = new Set<string>();
  for (const t of files) {
    if (t.kind !== 'test' || t.exclusion !== null) continue;
    let paired = edges.get(t.path)!;
    if (paired.length === 0) {
      const stem = testStem(t.name);
      const lastTestDir = t.dirs.findLastIndex((d) => TEST_DIRS.has(d));
      const dir = (lastTestDir === -1 ? t.dirs : t.dirs.slice(0, lastTestDir)).join('/');
      const matches = stem === null ? [] : (sourcesByStem.get(`${dir}\0${stem}`) ?? []);
      paired = matches.length === 1 ? matches : [];
    }
    if (paired.length === 0) unpaired.add(t.path);
    for (const s of paired) testsOf.set(s, [...(testsOf.get(s) ?? []), t.path]);
  }

  // Focused packets keep the supplied order; the rest follow by fan-in, then path.
  const ignoredFocusPaths: AnalysisPackets['ignoredFocusPaths'] = [];
  const focused: string[] = [];
  const seenFocus = new Set<string>();
  for (const path of opts.focusPaths) {
    if (seenFocus.has(path)) ignoredFocusPaths.push({ path, reason: 'repeat' });
    else if (!fileByPath.has(path)) ignoredFocusPaths.push({ path, reason: 'unknown' });
    else if (!isEligibleSource(fileByPath.get(path))) ignoredFocusPaths.push({ path, reason: 'not_source' });
    else focused.push(path);
    seenFocus.add(path);
  }
  const focusedSet = new Set(focused);
  const order = [
    ...focused,
    ...sources.map((s) => s.path).filter((p) => !focusedSet.has(p)).sort(byFanIn),
  ];

  const planned: PlannedPacket[] = order.map((path) => ({
    id: `p:${path}`,
    primary: [path],
    tests: [...(testsOf.get(path) ?? [])].sort(byCodeUnit),
    context: [...edges.get(path)!].sort(byFanIn).slice(0, opts.maxContextFiles),
  }));
  // Tests no source claims (absolute or package imports) still show testing work: their own packets.
  for (const path of [...unpaired].sort(byCodeUnit)) {
    planned.push({ id: `t:${path}`, primary: [path], tests: [], context: [] });
  }
  const supplemental = (kind: FileKind) =>
    files.filter((f) => f.kind === kind && f.exclusion === null && !summaries.has(f.path));
  planned.push({
    id: 'repository',
    primary: [...supplemental('manifest'), ...supplemental('ci'), ...supplemental('doc')].map(
      (f) => f.path,
    ),
    tests: [],
    context: [],
  });

  // Chunk-eligible: eligible sources, tests, unsummarized manifests, CI and docs.
  const chunksOf = new Map<string, Chunk[]>();
  for (const f of files) {
    if (f.exclusion === null && !summaries.has(f.path)) {
      chunksOf.set(f.path, chunkFile(f, opts.chunkLines));
    }
  }

  // Budget: summaries first, then packets in order. Tests and context are only attempted once a
  // packet has primary evidence, so a dropped packet never allocates anything.
  let remaining = opts.maxChars;
  const admittedSummaries = new Set<string>();
  for (const [path, summary] of [...summaries].sort(([a], [b]) => byCodeUnit(a, b))) {
    const cost = JSON.stringify(summary).length;
    if (cost > remaining) continue;
    remaining -= cost;
    admittedSummaries.add(path);
  }

  const emitted = new Map<string, Chunk>();
  const packets: Packet[] = [];
  for (const plan of planned) {
    let room = opts.maxCharsPerPacket;
    const inPacket = new Set<string>();
    const admitFile = (path: string, into: string[]) => {
      for (const chunk of chunksOf.get(path) ?? []) {
        if (inPacket.has(chunk.id)) continue;
        const cost = chunk.text.length;
        const isNew = !emitted.has(chunk.id);
        if (cost > room || (isNew && cost > remaining)) break;
        room -= cost;
        if (isNew) {
          emitted.set(chunk.id, chunk);
          remaining -= cost;
        }
        inPacket.add(chunk.id);
        into.push(chunk.id);
      }
    };

    const packet: Packet = { id: plan.id, primary: [], tests: [], context: [], size: 0 };
    for (const path of plan.primary) admitFile(path, packet.primary);
    if (packet.primary.length === 0) continue;
    for (const path of plan.tests) admitFile(path, packet.tests);
    for (const path of plan.context) admitFile(path, packet.context);
    packet.size = opts.maxCharsPerPacket - room;
    packets.push(packet);
  }

  const records: FileRecord[] = [];
  const omissions: Omission[] = snapshot.skipped.map(({ path, reason }) => ({ path, reason }));
  for (const f of files) {
    let status: FileStatus;
    const chunks = chunksOf.get(f.path);
    if (f.exclusion !== null) status = f.exclusion;
    else if (summaries.has(f.path)) {
      status = admittedSummaries.has(f.path) ? 'summarized' : 'summary_excluded';
    } else {
      const all = chunks!;
      const sent = all.filter((c) => emitted.has(c.id)).length;
      status = sent === all.length ? 'included' : sent === 0 ? 'excluded_budget' : 'partial';
      // Merge adjacent unemitted chunks into one budget omission.
      for (const chunk of all) {
        if (emitted.has(chunk.id)) continue;
        const last = omissions.at(-1);
        if (last?.reason === 'budget' && last.path === f.path && last.endLine + 1 === chunk.startLine) {
          last.endLine = chunk.endLine;
        } else {
          omissions.push({ path: f.path, reason: 'budget', startLine: chunk.startLine, endLine: chunk.endLine });
        }
      }
    }
    records.push({
      path: f.path,
      kind: f.kind,
      status,
      sha256: f.sha256,
      lineCount: f.original.length,
    });
  }

  omissions.sort(
    (a, b) =>
      byCodeUnit(a.path, b.path) ||
      Number(a.reason === 'budget') - Number(b.reason === 'budget') ||
      ('startLine' in a && 'startLine' in b ? a.startLine - b.startLine : 0) ||
      byCodeUnit(a.reason, b.reason),
  );

  return {
    repository: { owner: repository.owner, repo: repository.repo },
    commitSha: snapshot.commitSha,
    cleanerVersion: CLEANER_VERSION,
    options: opts,
    files: records,
    manifests: [...admittedSummaries].sort(byCodeUnit).map((path) => summaries.get(path)!),
    chunks: [...emitted.values()].sort(
      (a, b) => byCodeUnit(a.path, b.path) || a.startLine - b.startLine,
    ),
    packets,
    omissions,
    usedChars: opts.maxChars - remaining,
    ignoredFocusPaths,
  };
}
