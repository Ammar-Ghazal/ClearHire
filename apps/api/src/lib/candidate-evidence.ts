// Prepares one candidate's evidence across all selected repositories for a single model request.
// Personal evidence is only the exact attributed lines that are present in stored source; the
// surrounding chunks are context. Every line is sent once and keeps its own attribution.
import {
  attributeContributions,
  type CandidateIdentity,
  type CollectedContributions,
  type ContributionReport,
} from './attribution.js';
import type { RepoSnapshot } from './ingest.js';
import {
  buildPackets,
  sha256Hex,
  splitLines,
  type AnalysisPackets,
  type Chunk,
  type ManifestSummary,
} from './packets.js';

/** Bump when selection or rendering changes what the model sees for the same input. */
export const SELECTION_VERSION = 1;

export type DataUse = 'approved_public_demo' | 'restricted';
export type Attribution = 'sole' | 'shared' | 'provisional' | 'unknown';

export interface PreparedRepo {
  owner: string;
  repo: string;
  /** GitHub user ID the contributions were collected for. */
  collectedFor: number;
  snapshot: RepoSnapshot;
  collected: CollectedContributions;
}

export interface UnavailableRepo {
  owner: string;
  repo: string;
  unavailable: string;
  /** The pinned commit the failed fetch asked for, so a changed pin is fetched again. */
  requestedSha?: string | null;
}

export interface PreparedCandidate {
  subject: { kind: 'demo' | 'user'; key: string };
  identity: CandidateIdentity;
  repos: (PreparedRepo | UnavailableRepo)[];
  resume: { text: string } | null;
  dataUse: DataUse;
}

/** One contribution to one occurrence: `repo`, `path` and `snapshotSha` identify that copy. */
export interface LineContribution {
  repo: string;
  path: string;
  snapshotSha: string;
  commitSha: string;
  prNumber: number | null;
  authorship: 'sole' | 'shared' | 'undetermined';
  provisional: boolean;
  aiCoauthorDeclared: boolean;
}

export interface EvidenceItem {
  /** `c` = context chunk, `a` = attributed segment, `u` = unknown-attribution segment. */
  ref: string;
  kind: 'context' | 'attributed' | 'unknown';
  repo: string;
  commitSha: string;
  path: string;
  startLine: number;
  endLine: number;
  /** Redacted text exactly as sent to the model. */
  text: string;
  /** SHA-256 of the original, unredacted lines. */
  sha256: string;
  attribution: Attribution | null;
  contributions: LineContribution[];
  /** Identical copies elsewhere; identical content never transfers attribution between them. */
  alsoIn: Occurrence[];
}

export interface RepoEvidence {
  ref: string;
  repo: string;
  commitSha: string;
  fork: boolean;
  ownerIsCandidate: boolean;
}

export interface Omission {
  repo: string;
  path: string;
  reason: 'budget' | 'attributed_not_stored' | 'long_line' | 'generated' | 'not_processed' | 'context_omitted';
  startLine: number | null;
  endLine: number | null;
}

/** One file as rendered, so a request too large to send whole can be split by file. */
export interface EvidenceFile {
  /** `repoIndex\0path` of the rendering (canonical) copy. */
  key: string;
  text: string;
  /** Refs of the items rendered in this file. */
  refs: string[];
  /** Keys of its paired tests and imported files: context worth sending alongside it. */
  related: string[];
}

export interface EvidenceLayout {
  repos: { header: string; files: EvidenceFile[] }[];
  unavailable: string[];
}

export interface CandidateEvidence {
  repos: RepoEvidence[];
  items: EvidenceItem[];
  rendered: string;
  layout: EvidenceLayout;
  citableCount: number;
  coverage: {
    evidence: 'complete' | 'sampled';
    unavailableRepos: { repo: string; reason: string }[];
    omissions: Omission[];
    duplicates: (Occurrence & { duplicateOf: string })[];
    /** Contribution-report gaps (capped history, missing patches, failed lookups). */
    attributionGaps: {
      repo: string;
      reason: string;
      commitSha: string | null;
      path: string | null;
    }[];
    limitations: { repo: string; limitation: string }[];
  };
}

export interface Occurrence {
  repo: string;
  path: string;
  /** Snapshot SHA of that repository copy. */
  commitSha: string;
}

export class EvidenceInputError extends RangeError {}

const isAvailable = (r: PreparedRepo | UnavailableRepo): r is PreparedRepo => !('unavailable' in r);
const fullName = (r: { owner: string; repo: string }) => `${r.owner}/${r.repo}`;
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const joinLines = (lines: { text: string; eol: string }[]) =>
  lines.map((l) => l.text + l.eol).join('');
const MAX = Number.MAX_SAFE_INTEGER;

const TAG = /<(\/?)(repo|file|c|a|u|resume|job|dispute)(?=[\s>/])/g;
/** Repository text is untrusted: it can never open or close one of our delimiters. */
export const escapeDelimiters = (text: string) => text.replace(TAG, '&lt;$1$2');

function checkConsistency(prepared: PreparedCandidate, repo: PreparedRepo): void {
  const name = fullName(repo);
  const meta = repo.collected.repository;
  if (
    repo.collectedFor !== prepared.identity.githubUserId ||
    repo.snapshot.commitSha !== meta.commitSha ||
    repo.owner.toLowerCase() !== meta.owner.toLowerCase() ||
    repo.repo.toLowerCase() !== meta.repo.toLowerCase()
  ) {
    throw new EvidenceInputError(
      `Prepared evidence for ${name} does not match its candidate or commit`,
    );
  }
}

function packetsFor(repo: PreparedRepo, focusPaths: string[], maxChars: number): AnalysisPackets {
  return buildPackets(repo.snapshot, repo, { maxChars, maxCharsPerPacket: maxChars, focusPaths });
}

function exactPaths(report: ContributionReport): string[] {
  const paths = report.contributions.flatMap((c) =>
    c.ranges.filter((r) => r.mapping === 'exact').map((r) => r.path),
  );
  return [...new Set(paths)].sort(byCodeUnit);
}

/** Water-filling: small repositories keep everything; large ones share what remains equally. */
function allocate(needs: number[], budget: number): number[] {
  const out = needs.map(() => 0);
  const order = needs.map((_, i) => i).sort((a, b) => needs[a]! - needs[b]! || a - b);
  let remaining = budget;
  order.forEach((i, k) => {
    const share = Math.floor(remaining / (order.length - k));
    out[i] = Math.min(needs[i]!, share);
    remaining -= out[i]!;
  });
  return out;
}

function attributionOf(entries: LineContribution[]): Attribution {
  const citable = entries.filter((e) => e.authorship !== 'undetermined');
  if (citable.length === 0) return 'unknown';
  if (citable.length < entries.length || citable.some((e) => e.authorship === 'shared'))
    return 'shared';
  return citable.every((e) => e.provisional) ? 'provisional' : 'sole';
}

const entryKey = (e: LineContribution) => `${e.repo}\0${e.path}\0${e.commitSha}`;

/** `- path (ecosystem, package): section: name spec, ...; scripts: ...` from a parsed manifest. */
function renderManifest(m: ManifestSummary): string {
  const sections = new Map<string, string[]>();
  for (const d of m.dependencies) {
    sections.set(d.section, [...(sections.get(d.section) ?? []), `${d.name} ${d.spec}`.trim()]);
  }
  const parts = [...sections].map(([section, deps]) => `${section}: ${deps.join(', ')}`);
  if (m.scripts && m.scripts.length > 0) parts.push(`scripts: ${m.scripts.join(', ')}`);
  const label = m.name === undefined ? m.ecosystem : `${m.ecosystem}, ${m.name}`;
  return `- ${m.path} (${label}): ${parts.length > 0 ? parts.join('; ') : 'none'}`;
}

interface FileCopy {
  repoIndex: number;
  path: string;
  chunks: Chunk[];
}

/** Builds the evidence for one request, keeping prepared packets within `evidenceChars`. */
export function buildCandidateEvidence(
  prepared: PreparedCandidate,
  options: { evidenceChars: number },
): CandidateEvidence {
  const available = prepared.repos
    .filter(isAvailable)
    .sort((a, b) => byCodeUnit(fullName(a).toLowerCase(), fullName(b).toLowerCase()));
  const unavailableRepos = prepared.repos
    .filter((r): r is UnavailableRepo => !isAvailable(r))
    .map((r) => ({ repo: fullName(r), reason: r.unavailable }));
  for (const repo of available) checkConsistency(prepared, repo);

  // Attributed paths are known before chunking: 'exact' mapping depends on blobs, not packets.
  const focus = available.map((repo) =>
    exactPaths(
      attributeContributions(repo.collected, prepared.identity, {
        snapshot: repo.snapshot,
        packets: packetsFor(repo, [], 0),
      }),
    ),
  );
  const full = available.map((repo, i) => packetsFor(repo, focus[i]!, MAX));
  const needs = full.map((p) => p.usedChars);
  const total = needs.reduce((a, b) => a + b, 0);
  const shares = total <= options.evidenceChars ? needs : allocate(needs, options.evidenceChars);
  const packets = available.map((repo, i) =>
    shares[i]! >= needs[i]! ? full[i]! : packetsFor(repo, focus[i]!, shares[i]!),
  );
  const reports = available.map((repo, i) =>
    attributeContributions(repo.collected, prepared.identity, {
      snapshot: repo.snapshot,
      packets: packets[i]!,
    }),
  );

  const repos: RepoEvidence[] = available.map((repo, i) => ({
    ref: `r${i + 1}`,
    repo: fullName(repo),
    commitSha: repo.snapshot.commitSha,
    fork: reports[i]!.repository.fork,
    ownerIsCandidate: reports[i]!.repository.ownerIsCandidate,
  }));

  const omissions: Omission[] = [];
  packets.forEach((p, i) => {
    for (const o of p.omissions) {
      if (o.reason === 'budget') {
        omissions.push({ repo: repos[i]!.repo, ...o });
      }
    }
    for (const f of p.files) {
      if (f.status !== 'summary_excluded') continue;
      const whole = { startLine: null, endLine: null };
      omissions.push({ repo: repos[i]!.repo, path: f.path, reason: 'budget', ...whole });
    }
  });

  // Group identical files across repositories; the first occurrence renders them.
  const groups = new Map<string, FileCopy[]>();
  const groupOf = new Map<string, string>();
  packets.forEach((p, repoIndex) => {
    const chunksByPath = new Map<string, Chunk[]>();
    for (const c of p.chunks) chunksByPath.set(c.path, [...(chunksByPath.get(c.path) ?? []), c]);
    for (const f of p.files) {
      const chunks = chunksByPath.get(f.path);
      if (!chunks) continue;
      groups.set(f.sha256, [...(groups.get(f.sha256) ?? []), { repoIndex, path: f.path, chunks }]);
    }
  });
  // Chunk-eligible files map to their group even when this copy's own chunks were not emitted.
  const CHUNKED = new Set(['included', 'partial', 'excluded_budget']);
  const excludedFiles = new Map<string, 'long_line' | 'generated'>();
  const longLines = new Map<string, Set<number>>();
  packets.forEach((p, repoIndex) => {
    for (const f of p.files) {
      const key = `${repoIndex}\0${f.path}`;
      if (CHUNKED.has(f.status)) groupOf.set(key, f.sha256);
      if (f.status === 'long_line' || f.status === 'generated') excludedFiles.set(key, f.status);
    }
    for (const o of p.omissions) {
      if (o.reason !== 'long_line') continue;
      const key = `${repoIndex}\0${o.path}`;
      const lines = longLines.get(key) ?? new Set<number>();
      lines.add(o.startLine);
      longLines.set(key, lines);
    }
  });

  // Per-line attribution, keyed by group and line number; lines outside stored chunks are omitted.
  const lineEntries = new Map<string, Map<number, LineContribution[]>>();
  const storedLines = new Map<string, Set<number>>();
  for (const [hash, occurrences] of groups) {
    const lines = new Set<number>();
    for (const o of occurrences) {
      for (const c of o.chunks) for (let n = c.startLine; n <= c.endLine; n++) lines.add(n);
    }
    storedLines.set(hash, lines);
  }
  reports.forEach((report, repoIndex) => {
    const { repo, commitSha: snapshotSha } = repos[repoIndex]!;
    for (const c of report.contributions) {
      if (c.authorship === 'not_author') continue;
      for (const r of c.ranges) {
        if (r.mapping !== 'exact') continue;
        const entry: LineContribution = {
          repo,
          path: r.path,
          snapshotSha,
          commitSha: c.commitSha,
          prNumber: c.prNumber ?? null,
          authorship: c.authorship,
          provisional: c.provisional,
          aiCoauthorDeclared: c.aiCoauthorDeclared,
        };
        // Summarized manifests, empty and ingest-filtered files hold no reviewable code.
        const key = `${repoIndex}\0${r.path}`;
        const hash = groupOf.get(key);
        if (hash === undefined) {
          const reason = excludedFiles.get(key);
          if (reason) {
            omissions.push({ repo, path: r.path, reason, startLine: r.start, endLine: r.end });
          }
          continue;
        }
        const stored = storedLines.get(hash);
        const overlong = longLines.get(key);
        let missing: Omission | undefined;
        for (let n = r.start; n <= r.end; n++) {
          if (!stored?.has(n)) {
            const reason = overlong?.has(n) ? 'long_line' : 'attributed_not_stored';
            if (missing?.reason === reason) {
              missing.endLine = n;
            } else {
              missing = { repo, path: r.path, reason, startLine: n, endLine: n };
              omissions.push(missing);
            }
            continue;
          }
          missing = undefined;
          const byLine = lineEntries.get(hash) ?? new Map<number, LineContribution[]>();
          lineEntries.set(hash, byLine);
          const list = byLine.get(n) ?? [];
          if (!list.some((e) => entryKey(e) === entryKey(entry))) list.push(entry);
          byLine.set(n, list);
        }
      }
    }
  });

  const refOf = new Map(repos.map((r) => [r.repo, r.ref]));
  const items: EvidenceItem[] = [];
  const duplicates: CandidateEvidence['coverage']['duplicates'] = [];
  const counters = { c: 0, a: 0, u: 0 };
  const blocks: string[] = [];
  const layout: EvidenceLayout = { repos: [], unavailable: [] };
  // Related files by path within each repository, from its packets' tests and context.
  const keyOf = (repoIndex: number, path: string) => {
    const hash = groupOf.get(`${repoIndex}\0${path}`);
    const owner = hash === undefined ? undefined : groups.get(hash)?.[0];
    return owner && `${owner.repoIndex}\0${owner.path}`;
  };
  const related = new Map<string, Set<string>>();
  packets.forEach((p, repoIndex) => {
    const pathOf = new Map(p.chunks.map((c) => [c.id, c.path]));
    for (const packet of p.packets) {
      const primary = new Set(packet.primary.map((id) => pathOf.get(id)!));
      const others = new Set([...packet.tests, ...packet.context].map((id) => pathOf.get(id)!));
      for (const path of primary) {
        const key = keyOf(repoIndex, path);
        if (!key) continue;
        const set = related.get(key) ?? new Set<string>();
        for (const other of others) {
          const otherKey = keyOf(repoIndex, other);
          if (otherKey && otherKey !== key) set.add(otherKey);
        }
        related.set(key, set);
      }
    }
  });

  repos.forEach((repoEvidence, repoIndex) => {
    const p = packets[repoIndex]!;
    const out: string[] = [
      `<repo ref="${repoEvidence.ref}" name="${repoEvidence.repo}" commit="${repoEvidence.commitSha}" ` +
        `fork="${repoEvidence.fork}" owner_is_candidate="${repoEvidence.ownerIsCandidate}">`,
      ...(p.manifests.length > 0
        ? [
            'dependencies (context only; installed packages were not sent and prove no skill):',
            ...p.manifests.map((m) => escapeDelimiters(renderManifest(m))),
          ]
        : []),
    ];

    const headerLines = out.length;
    const files: EvidenceFile[] = [];
    const owned = [...groups.entries()].filter(([, occ]) => occ[0]!.repoIndex === repoIndex);
    owned.sort(([, a], [, b]) => byCodeUnit(a[0]!.path, b[0]!.path));
    for (const [hash, occurrences] of owned) {
      const canonical = occurrences[0]!;
      const alsoIn = occurrences.slice(1).map((o) => ({
        repo: repos[o.repoIndex]!.repo,
        path: o.path,
        commitSha: repos[o.repoIndex]!.commitSha,
      }));
      for (const dup of alsoIn) {
        duplicates.push({ ...dup, duplicateOf: `${repoEvidence.repo}:${canonical.path}` });
      }
      const file = available[repoIndex]!.snapshot.files.find((f) => f.path === canonical.path)!;
      const original = splitLines(file.content);
      const chunks = new Map<string, Chunk>();
      for (const o of occurrences) for (const c of o.chunks) chunks.set(`${c.startLine}`, c);
      const byLine = lineEntries.get(hash) ?? new Map<number, LineContribution[]>();

      const alsoAttr =
        alsoIn.length > 0
          ? ` also_in="${alsoIn.map((d) => `${refOf.get(d.repo)}:${d.path}`).join(' ')}"`
          : '';
      const fileStart = out.length;
      const itemStart = items.length;
      out.push(`<file path="${canonical.path}"${alsoAttr}>`);
      for (const chunk of [...chunks.values()].sort((a, b) => a.startLine - b.startLine)) {
        const ref = `c${++counters.c}`;
        const redacted = splitLines(chunk.text);
        items.push({
          ref,
          kind: 'context',
          repo: repoEvidence.repo,
          commitSha: repoEvidence.commitSha,
          path: canonical.path,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          text: chunk.text,
          sha256: chunk.sha256,
          attribution: null,
          contributions: [],
          alsoIn,
        });
        out.push(`<c ref="${ref}" lines="${chunk.startLine}-${chunk.endLine}">`);

        let n = chunk.startLine;
        while (n <= chunk.endLine) {
          const entries = byLine.get(n);
          const lineText = (k: number) =>
            escapeDelimiters(redacted[k - chunk.startLine]?.text ?? '');
          if (!entries) {
            out.push(lineText(n));
            n++;
            continue;
          }
          const key = entries.map(entryKey).sort().join('|');
          let end = n;
          while (
            end + 1 <= chunk.endLine &&
            byLine
              .get(end + 1)
              ?.map(entryKey)
              .sort()
              .join('|') === key
          )
            end++;
          const attribution = attributionOf(entries);
          const kind = attribution === 'unknown' ? 'unknown' : 'attributed';
          const segRef = kind === 'unknown' ? `u${++counters.u}` : `a${++counters.a}`;
          const segRedacted = redacted.slice(n - chunk.startLine, end - chunk.startLine + 1);
          items.push({
            ref: segRef,
            kind,
            repo: repoEvidence.repo,
            commitSha: repoEvidence.commitSha,
            path: canonical.path,
            startLine: n,
            endLine: end,
            text: joinLines(segRedacted),
            sha256: sha256Hex(joinLines(original.slice(n - 1, end))),
            attribution,
            contributions: entries,
            alsoIn,
          });
          const commits = new Set(entries.map((e) => e.commitSha)).size;
          const prs = [
            ...new Set(entries.flatMap((e) => (e.prNumber === null ? [] : [`#${e.prNumber}`]))),
          ];
          const tag = kind === 'unknown' ? 'u' : 'a';
          // Names the repositories whose own history attributes these lines.
          const from = [...new Set(entries.map((e) => refOf.get(e.repo)!))].sort().join(' ');
          out.push(
            `<${tag} ref="${segRef}" lines="${n}-${end}" attribution="${attribution}" commits="${commits}"` +
              ` contributed_in="${from}"${prs.length > 0 ? ` prs="${prs.join(' ')}"` : ''}>`,
          );
          for (let k = n; k <= end; k++) out.push(lineText(k));
          out.push(`</${tag}>`);
          n = end + 1;
        }
        out.push('</c>');
      }
      out.push('</file>');
      const key = `${repoIndex}\0${canonical.path}`;
      files.push({
        key,
        text: out.slice(fileStart).join('\n'),
        refs: items.slice(itemStart).map((i) => i.ref),
        related: [...(related.get(key) ?? [])].sort(byCodeUnit),
      });
    }
    layout.repos.push({ header: out.slice(0, headerLines).join('\n'), files });
    out.push('</repo>');
    blocks.push(out.join('\n'));
  });
  for (const r of unavailableRepos) {
    const block = `<repo name="${r.repo}" unavailable="${escapeDelimiters(r.reason)}"></repo>`;
    blocks.push(block);
    layout.unavailable.push(block);
  }

  return {
    repos,
    items,
    rendered: blocks.join('\n'),
    layout,
    citableCount: counters.a,
    coverage: {
      evidence: omissions.length > 0 ? 'sampled' : 'complete',
      unavailableRepos,
      omissions,
      duplicates,
      attributionGaps: reports.flatMap((report, i) =>
        report.coverage.gaps.map((g) => ({
          repo: repos[i]!.repo,
          reason: g.reason,
          commitSha: g.commitSha ?? null,
          path: g.path ?? null,
        })),
      ),
      limitations: reports.flatMap((report, i) =>
        report.limitations.map((limitation) => ({ repo: repos[i]!.repo, limitation })),
      ),
    },
  };
}

/**
 * Renders the files in `keys` exactly as the whole evidence renders them, each repository with its
 * header and dependencies. Repositories without files and unavailable ones go with the first part.
 */
export function renderEvidence(layout: EvidenceLayout, keys: ReadonlySet<string>, first: boolean) {
  const blocks: string[] = [];
  for (const repo of layout.repos) {
    const files = repo.files.filter((f) => keys.has(f.key));
    if (files.length === 0 && !(first && repo.files.length === 0)) continue;
    blocks.push([repo.header, ...files.map((f) => f.text), '</repo>'].join('\n'));
  }
  if (first) blocks.push(...layout.unavailable);
  return blocks.join('\n');
}
