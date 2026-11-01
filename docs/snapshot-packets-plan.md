# Plan v3: snapshot cleanup → analysis packets

## Scope and decisions
- Implement only `apps/api/src/lib/packets.ts` and `packets.test.ts`; no implementation is included in this plan.
- Stack: existing Node.js >=22.12, TypeScript, ESM `.js` imports, `node:crypto` SHA-256 and Vitest; no new dependencies.
- Pure synchronous transform; import `RepoSnapshot` and `SkipReason` as types. Octokit stays in the ingestion caller.
- Preserve the existing 100-skill `clearhire-skills-v1` catalogue; later consumers use its `catalogue_id`/`skill_id`. This component emits evidence, not skill ratings.
- Accept v2's bounded manifest scanners, prefix admission and ordered focus paths; amend deduplication to preserve classification and raw file identity.
- Defer I/O, execution, Muse Spark, Modal, persistence, routes, UI, attribution, scoring, schemas, syntax parsers and token estimation.

## 1. Define contracts and validate options — TypeScript
- Export `CLEANER_VERSION = 1`, `DEFAULT_PACKET_OPTIONS` and `buildPackets(snapshot, repository, options?: Partial<PacketOptions>): AnalysisPackets`.
- `snapshot: RepoSnapshot`; `repository: { owner: string; repo: string }`; clone inputs, never mutate them.
- Options: `maxChars=120_000`, `maxCharsPerPacket=24_000`, `chunkLines=120`, `maxContextFiles=4`, `focusPaths=[]`.
- Numeric options must be safe integers: budgets >=0, chunkLines 1–1000, maxContextFiles 0–20; focusPaths must be string[].
- Reject unknown keys/types/ranges with `RangeError('Invalid packet option: <key>')`; never include option values in errors.
- `FileRecord`: `{ path: string; sha256: string; lineCount: number; kind: 'manifest'|'source'|'test'|'ci'|'doc'; status: FileStatus; duplicateOf?: string }`.
- `FileStatus`: `included|partial|excluded_budget|summarized|duplicate|generated|empty|unpaired` (string-literal union).
- `Chunk`: `{ id: string; path: string; startLine: number; endLine: number; sha256: string; text: string; redactions: { line: number; kind: string }[] }`.
- `ManifestSummary`: `{ path: string; ecosystem: 'npm'|'pypi'|'go'|'cargo'; name?: string; dependencies: { name: string; version?: string; section: string; line: number }[]; scripts?: string[] }`.
- `Packet`: `{ id: string; primary: string[]; tests: string[]; context: string[] }`; lists contain emitted chunk IDs.
- `Omission`: `{ path: string; reason: SkipReason|'budget'; startLine?: number; endLine?: number }`; budget ranges include both line fields unless the file is an unadmitted summary.
- `AnalysisPackets`: `{ repository, commitSha, cleanerVersion, options: PacketOptions, files: FileRecord[], manifests: ManifestSummary[], chunks: Chunk[], packets: Packet[], omissions: Omission[], ignoredFocusPaths: string[], usedChars: number }`.
- Accept: defaults resolve correctly, invalid inputs fail predictably, and output types compile without `any`.

## 2. Preserve source identity and classify — TypeScript and node:crypto
- Split CRLF, LF and lone CR as line endings, retaining terminators; final terminators add no phantom line; retain BOM. Empty content has zero lines.
- Ranges are 1-based/inclusive; text preserves original terminators after redaction. SHA-256 hashes UTF-8 original unredacted text, including terminators/BOM.
- Record whole-file hashes for all files; chunk hashes cover their exact original substrings. CR-only ranges use this internal convention; GitHub display equivalence is not guaranteed.
- Classification precedence: manifest → test → CI → doc → source; names and POSIX paths are case-sensitive.
- Manifest basenames: package.json, pyproject.toml, go.mod, Cargo.toml, or `^requirements([-_.][\w-]+)?\.txt$`.
- Tests: directory segment `__tests__|test|tests|spec`, or basename `*.test.*|*.spec.*|test_*.py|*_test.py|*_test.go`.
- CI: `.github/workflows/` with `.yml|.yaml`; docs: `.md|.mdx|.rst|.txt` extension or first segment `docs`; remainder is source.
- Apply exclusion status separately: empty first; then generated if basename contains `.min.`, any line body exceeds 1000 UTF-16 units, or first five lines contain `@generated`/`DO NOT EDIT`.
- Apply generated exclusions to manifests too, ensuring every subsequently scanned line is bounded; preserve the file's classification in its record.
- Accept: fixtures cover every rule, collisions, empty/BOM files, all line endings and exact hashes.

## 3. Redact before parsing or chunking — bounded regex and line scanner
- Process all non-excluded files; preserve terminators and line count; collect unique absolute `{line, kind}` records, sorted by line then kind.
- PEM: redact whole line bodies from a PRIVATE KEY BEGIN marker through the matching END inclusively; unmatched BEGIN redacts through EOF.
- Inline patterns: GitHub `gh[pousr]_` + 36–255 alphanumeric/underscore characters or `github_pat_` + 22–255; AWS `(AKIA|ASIA)` + 16 uppercase alphanumerics.
- Also detect Slack `xox[abprs]-` + 10–255 alphanumeric/underscore/hyphen characters and `sk-` + 20–255 of the same characters.
- JWT: three dot-separated base64url segments, each 8–512 characters; tokens require boundaries outside their respective token alphabets.
- URL password: nonempty password between `scheme://user:` and `@`, excluding whitespace; assignment: quoted value >=8 characters after a matching key and `:` or `=`.
- Assignment keys may be quoted and case-insensitively contain password, passwd, secret, token, api_key, apikey, private_key or client_secret.
- Match spans cover token/value only; resolve by start position, longest span, then listed kind order; PEM wins first. Replace spans with `[REDACTED:<kind>]`.
- Parse manifests from redacted text; invalidated syntax falls back to chunks. Never expose raw parser errors or script bodies; detection is heuristic, not exhaustive.
- Accept: fixture secrets never appear in serialized output; PEM crossing windows/EOF and overlapping matches work; redacted chunks are non-quotable for later validators.

## 4. Summarize supported manifests — JSON.parse and conservative scanners
- Return a complete summary or `null`; unsupported dependency syntax/sections, malformed recognized fields or uncertain line mapping require whole-file chunk fallback.
- npm: root object, optional string name, string-valued dependencies/devDependencies/peerDependencies/optionalDependencies, and string-valued scripts; emit script names only.
- A string-aware JSON scanner maps dependency keys to lines and rejects duplicate keys within an object; compact JSON maps to line 1. Parse/scanner disagreement returns null.
- requirements: named requirements with optional extras, constraints, markers and comments; strip comments/markers. Options, includes, URLs, `@` or continuations return null.
- pyproject: `[project]` name/dependencies and `[project.optional-dependencies]` quoted-string arrays, including multiline arrays; Poetry, dependency-groups or dynamic dependencies return null.
- Go: module plus single/block require; preserve indirect section. Ignore go/toolchain only; replace/exclude/retract/unknown directives return null to preserve their semantics.
- Cargo: `[package]` name and dependencies/dev-dependencies/build-dependencies with string versions only; inline tables, target/workspace dependencies and dependency subtables return null.
- Ignore unrelated fields in npm/TOML; scanners must recognize their boundaries safely or fall back. Do not attempt general-purpose TOML parsing.
- Sections: npm/Cargo table name; requirements `dependencies`; pyproject `dependencies` or `optional:<group>`; Go `require` or `indirect`.
- Preserve dependency source order and entry-start lines, including repeated names in different sections; omit absent optional fields; sort script names by code units.
- Accept: each supported form has exact-line fixtures; unsupported/malformed forms retain their entire redacted body as supplemental chunk candidates.

## 5. Deduplicate and chunk — node:crypto and TypeScript
- Deduplicate only non-manifest, non-excluded files of the same classification, using exact original content hashes; smallest path wins. Do not normalize away provenance differences.
- Keep aliases as FileRecords with their own hashes and `duplicateOf`; redirect import/focus targets to canonical paths. Scan alias locations too, unioning their links/pairings into the canonical file.
- No cross-file chunk-content deduplication; retained files split into consecutive `chunkLines` windows, ID `${path}#L${start}-L${end}`.
- Accept: source/test duplicates remain separate, alias-relative imports use the alias directory, and 300 lines yield 120/120/60-line windows.

## 6. Resolve imports and pair tests — bounded per-line regex
- Scan redacted source/test text for literal JS/TS `from`, side-effect import, import() and require() using `./` or `../`; comment matches are an acknowledged limitation.
- Normalize against the importing path's directory; reject root escapes. Try exact path, extension substitution, appended extensions, then `/index` extensions.
- Substitutions: `.js→.ts,.tsx`, `.jsx→.tsx`, `.mjs→.mts`, `.cjs→.cts`; append/index order: `.ts,.tsx,.js,.jsx,.mjs,.cjs,.mts,.cts`.
- Python: `from .mod import ...` resolves mod `.py` then `/__init__.py`; n leading dots ascend n−1 levels. For `from .. import a,b`, resolve each named module; defer aliases/star/multiline forms.
- Resolve only available canonical source targets; ignore unresolved/bare/absolute imports. Pair tests to every directly imported source.
- Otherwise strip language-appropriate test markers/extensions and compare stems in the same directory, or immediate parent of a named test directory; exactly one candidate pairs, otherwise unpaired.
- Unpaired test fixtures/helpers are excluded in v1. Accept: extension substitutions, Python dots, aliases, escapes and monorepo stem ambiguity have fixtures.

## 7. Rank, admit and account — deterministic TypeScript
- Fan-in counts distinct canonical source importers, excluding self. Focus exact source paths in supplied order; canonicalize aliases and keep the first occurrence.
- Unknown/non-source focus entries go to ignoredFocusPaths in first-seen order. Rank focused packets by focus position, then remaining packets by fan-in descending/path ascending.
- Source packet `p:<path>`: primary windows, paired tests by path, then direct imports by fan-in/path, limited to maxContextFiles; remove self-context and repeated IDs.
- Final packet `repository`: primary files are fallback manifests, then CI, then docs, each by path. Emit packets only when a primary chunk fits.
- Charge chunks by text.length and summaries by JSON.stringify(summary).length; global usedChars counts unique emitted items, while every packet reference counts against its packet cap.
- Admit whole summaries first in path order; rejected summaries get excluded_budget plus a whole-file budget omission; continue to later summaries without chunk fallback.
- Visit packets in rank order, primary→tests→context. Within each file admit a prefix until a chunk cannot fit, then try the next file; shared chunks cost zero extra globally.
- If no primary fits, skip that packet's tests/context. Zero maxChars admits nothing; budgets exclude metadata/reference overhead and do not represent model tokens.
- Final file status uses globally emitted coverage: all lines included, some partial, none excluded_budget; successful admitted summaries are summarized; aliases/exclusions/unpaired retain their statuses.
- Carry snapshot.skipped verbatim; for chunk candidates never emitted anywhere add merged adjacent budget ranges. Chunk ranges plus budget ranges partition each candidate file's lines exactly once.
- Sort files/manifests by path, chunks by path/startLine, omissions by path/startLine/reason, using code units; preserve ranked packet order. Every reference resolves.
- Accept: test zero/tiny budgets, rejected summaries, prefix selection, shared costs, primary gating, statuses, complete coverage and per-packet/global caps.

## 8. Orchestrate and verify — Vitest and pnpm
- Run tasks 1–7 in order; deep-frozen inputs must work, and shuffled snapshot files/skips must produce byte-identical JSON. Focus order intentionally affects output.
- Test inert process.exit/child-process/postinstall content; implementation uses no eval, repository imports, filesystem, subprocess or network APIs.
- Run `pnpm --filter @clearhire/api exec vitest run src/lib/packets.test.ts`, then `pnpm typecheck` and `pnpm test`; all must pass.
- Defaults are explicit v1 settings, tunable after model-cost measurements. Catalogue committing is separate work. Claude must confirm the amended decisions before implementation agreement is claimed.
