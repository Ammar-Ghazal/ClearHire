// Imports the saved demo fixtures. Phase A reads, validates and extracts resume PDFs with no
// transaction open; phase B writes only changed fields in one transaction. Demo subjects never
// reference users. Errors name the file, record and field, never values.
import { eq, inArray } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { z } from 'zod';
import { db } from '../db/client.js';
import { demoCandidates, demoEmployers, demoJobs, jobPriorityOverrides } from '../db/schema.js';
import { RUN_STALE_MS, type SelectedRepo } from './demo-prepare.js';
import { canonicalJson } from './muse.js';
import { sha256Hex } from './packets.js';
import { extractResume, type ResumeExtraction } from './resume-pdf.js';

export class DemoImportError extends Error {
  constructor(readonly issues: string[]) {
    super(`Demo import rejected:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
  }
}

// ---- File schemas: passthrough, so unknown fields survive in `raw` ----

const SHA1 = z.string().regex(/^[0-9a-f]{40}$/);
const GITHUB_URL = z.string().regex(/github\.com\/[^/?#]+/);

const EmployerSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    description: z.string(),
    url: z.string(),
    location: z.string().min(1).optional(),
  })
  .passthrough();

const JobSchema = z
  .object({
    id: z.string().min(1),
    employer_id: z.string().min(1),
    title: z.string().min(1),
    location: z.string().optional(),
    requirements_summary: z.array(z.string()).min(1),
    source_url: z.string(),
    source_checked: z.string().optional(),
    scenario: z.enum(['possible_skill_overlap', 'out_of_scope_negative_control']),
  })
  .passthrough();

// Retrieved posting content, one per jobs.json entry; `sourceText` is what the source supplied.
const PostingsSchema = z
  .object({
    retrievedOn: z.string().min(1),
    postings: z.array(
      z
        .object({
          id: z.string().min(1),
          sourceUrl: z.string(),
          sourceChecked: z.string().nullable().optional(),
          sourceStatus: z.enum(['full_description', 'source_summary']),
          sourceText: z.string().trim().min(1),
          sourceLimitations: z.array(z.string()).optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

// Four recorded shapes; only the name and the pinned commit matter for fetching.
const RepoSchema = z
  .object({
    full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    pinned_commit_sha: SHA1.optional(),
    commit_sha: SHA1.optional(),
  })
  .passthrough();

const ProfileSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1),
    github_url: GITHUB_URL,
    github_login: z.string().optional(),
    github_username: z.string().optional(),
    resume_url: z.string().nullable(),
    resume_type: z.string().nullable(),
    identity_match_verified: z.boolean().optional(),
    public_repositories_verified: z.boolean().optional(),
    source: z.string().optional(),
    selected_repositories: z.array(RepoSchema),
  })
  .passthrough();

const CuratedSchema = z
  .object({
    profiles: z.array(ProfileSchema),
    user_profiles_without_resume: z.array(ProfileSchema),
  })
  .passthrough();

const UserSuppliedSchema = z
  .object({
    verification_status: z.string(),
    profiles: z.array(z.object({ name: z.string(), github_url: GITHUB_URL }).passthrough()),
  })
  .passthrough();

const ManifestSchema = z
  .object({
    version: z.literal(1),
    resumes: z.array(
      z
        .object({
          key: z.string().min(1),
          kind: z.enum(['original_public_resume', 'reconstructed_demo_resume']),
          sources: z.array(z.string()),
          limitations: z.array(z.string()),
          file: z.string().regex(/^data\/demo\/resumes\/[^/]+\.pdf$/),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
          limited_source: z.boolean(),
          github_account_kind: z.string(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

// ---- Normalised records ----

export interface EmployerRecord {
  id: string;
  name: string;
  description: string;
  url: string;
  location: string | null;
  raw: unknown;
  recordSha256: string;
}

export interface JobRecord {
  id: string;
  employerId: string;
  title: string;
  location: string | null;
  sourceUrl: string;
  sourceChecked: string | null;
  scenario: string;
  inScope: boolean;
  text: string;
  textSource: 'full_description' | 'source_summary' | 'fixture_summary';
  retrievedOn: string | null;
  sourceLimitations: string[];
  raw: unknown;
  recordSha256: string;
  inputSha256: string;
}

export interface ResumeSource {
  kind: 'original_public_resume' | 'reconstructed_demo_resume';
  sources: string[];
  limitations: string[];
  limitedSource: boolean;
  githubAccountKind: string;
}

export interface CandidateRecord {
  key: string;
  name: string;
  githubUrl: string;
  githubLogin: string;
  organization: boolean;
  repositories: SelectedRepo[];
  verification: {
    identityMatchVerified: boolean | null;
    publicRepositoriesVerified: boolean | null;
    source: string | null;
    userSuppliedStatus: string | null;
  };
  raw: unknown;
  profileSha256: string;
  resumeUrl: string | null;
  resumeType: string | null;
  resumeSource: ResumeSource | null;
  /** Repo-relative manifest path and its recorded hash; null when there is no resume. */
  resumeFile: string | null;
  resumeSha256: string | null;
}

export interface DemoData {
  employers: EmployerRecord[];
  jobs: JobRecord[];
  candidates: CandidateRecord[];
}

export interface DemoFiles {
  employers: unknown;
  jobs: unknown;
  curated: unknown;
  userSupplied: unknown;
  manifest: unknown;
  /** full-postings.json: the maintained posting content. */
  postings: unknown;
}

const hashOf = (value: unknown) => sha256Hex(canonicalJson(value));
const loginFromUrl = (url: string) => /github\.com\/([^/?#]+)/.exec(url)![1]!;
const urlKey = (url: string) => url.trim().replace(/\/+$/, '').toLowerCase();

function parse<T>(schema: z.ZodType<T>, value: unknown, file: string, issues: string[]) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  for (const issue of result.error.issues) {
    issues.push(`${file}: ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  return undefined;
}

/** Validates and normalises the fixtures. Pure: reads no files and writes nothing. */
export function validateDemoData(files: DemoFiles): DemoData {
  const issues: string[] = [];
  const employerRows = parse(z.array(EmployerSchema), files.employers, 'employers.json', issues);
  const jobRows = parse(z.array(JobSchema), files.jobs, 'jobs.json', issues);
  const curated = parse(CuratedSchema, files.curated, 'curated-profiles.json', issues);
  const supplied = parse(
    UserSuppliedSchema,
    files.userSupplied,
    'user-supplied-profiles.json',
    issues,
  );
  const manifest = parse(ManifestSchema, files.manifest, 'resumes/manifest.json', issues);
  const postingFile = parse(PostingsSchema, files.postings, 'full-postings.json', issues);
  if (!employerRows || !jobRows || !curated || !supplied || !manifest || !postingFile) {
    throw new DemoImportError(issues);
  }
  // Records keep their original JSON for `raw`; the parsed copies only drive normalisation.
  const original = <T>(value: unknown, path: (string | number)[]) =>
    path.reduce<unknown>((v, p) => (v as Record<string | number, unknown>)[p], value) as T;

  const employers = employerRows.map((e, i) => {
    const raw = original(files.employers, [i]);
    return {
      id: e.id,
      name: e.name,
      description: e.description,
      url: e.url,
      location: e.location ?? null,
      raw,
      recordSha256: hashOf(raw),
    };
  });
  const employerById = new Map<string, EmployerRecord>();
  employers.forEach((e, i) => {
    if (employerById.has(e.id)) issues.push(`employers.json: ${i}.id: duplicate employer id`);
    employerById.set(e.id, e);
  });

  const postings = new Map<string, (typeof postingFile.postings)[number]>();
  postingFile.postings.forEach((p, i) => {
    if (postings.has(p.id)) issues.push(`full-postings.json: postings.${i}.id: duplicate job id`);
    if (!jobRows.some((j) => j.id === p.id)) {
      issues.push(`full-postings.json: postings.${i}.id: no job with this id`);
    }
    postings.set(p.id, p);
  });

  const jobIds = new Set<string>();
  const jobs: JobRecord[] = [];
  jobRows.forEach((j, i) => {
    if (jobIds.has(j.id)) issues.push(`jobs.json: ${i}.id: duplicate job id`);
    jobIds.add(j.id);
    const employer = employerById.get(j.employer_id);
    if (!employer) {
      issues.push(`jobs.json: ${i}.employer_id: no employer with this id`);
      return;
    }
    const posting = postings.get(j.id);
    if (posting && posting.sourceUrl !== j.source_url) {
      issues.push(`full-postings.json: ${j.id}: sourceUrl differs from jobs.json source_url`);
    }
    // Without retrieved content the abbreviated notes are used, labelled as such.
    const textSource = posting?.sourceStatus ?? 'fixture_summary';
    const text =
      posting?.sourceText ??
      [
        `${j.title} at ${employer.name}`,
        'Abbreviated research notes, not the full job description:',
        ...j.requirements_summary,
      ].join('\n');
    const retrievedOn = posting ? postingFile.retrievedOn : null;
    const sourceLimitations = posting?.sourceLimitations ?? [];
    const raw = original(files.jobs, [i]);
    jobs.push({
      id: j.id,
      employerId: j.employer_id,
      title: j.title,
      location: j.location ?? null,
      sourceUrl: j.source_url,
      sourceChecked: posting?.sourceChecked ?? j.source_checked ?? null,
      scenario: j.scenario,
      inScope: j.scenario !== 'out_of_scope_negative_control',
      text,
      textSource,
      retrievedOn,
      sourceLimitations,
      raw,
      recordSha256: hashOf({ raw, text, retrievedOn, sourceLimitations }),
      inputSha256: hashOf({ employerId: j.employer_id, title: j.title, text, textSource }),
    });
  });

  const suppliedByUrl = new Map<string, unknown>();
  supplied.profiles.forEach((p, i) =>
    suppliedByUrl.set(urlKey(p.github_url), original(files.userSupplied, ['profiles', i])),
  );
  const resumes = new Map<string, z.infer<typeof ManifestSchema>['resumes'][number]>();
  manifest.resumes.forEach((r, i) => {
    if (resumes.has(r.key)) issues.push(`resumes/manifest.json: resumes.${i}.key: duplicate key`);
    resumes.set(r.key, r);
  });

  const matchedUrls = new Set<string>();
  const keys = new Set<string>();
  const logins = new Set<string>();
  const candidates: CandidateRecord[] = [];
  const sections = [
    ['profiles', curated.profiles],
    ['user_profiles_without_resume', curated.user_profiles_without_resume],
  ] as const;
  for (const [section, profiles] of sections) {
    profiles.forEach((p, i) => {
      const at = `curated-profiles.json: ${section}.${i}`;
      // Established keys: an explicit id, otherwise the login exactly as it appears in the URL.
      const urlLogin = loginFromUrl(p.github_url);
      const key = p.id ?? urlLogin;
      const githubLogin = p.github_login ?? p.github_username ?? urlLogin;
      if (keys.has(key.toLowerCase())) issues.push(`${at}: duplicate candidate key`);
      if (logins.has(githubLogin.toLowerCase())) issues.push(`${at}: duplicate GitHub identity`);
      keys.add(key.toLowerCase());
      logins.add(githubLogin.toLowerCase());

      const suppliedRecord = suppliedByUrl.get(urlKey(p.github_url));
      if (suppliedRecord) matchedUrls.add(urlKey(p.github_url));
      const resume = resumes.get(key);
      const raw = {
        curated: original(files.curated, [section, i]),
        userSupplied: suppliedRecord ?? null,
      };
      candidates.push({
        key,
        name: p.name,
        githubUrl: p.github_url,
        githubLogin,
        organization: resume?.github_account_kind === 'organization',
        repositories: p.selected_repositories.map((r) => {
          const [owner, repo] = r.full_name.split('/') as [string, string];
          return { owner, repo, pinnedSha: r.pinned_commit_sha ?? r.commit_sha ?? null };
        }),
        verification: {
          identityMatchVerified: p.identity_match_verified ?? null,
          publicRepositoriesVerified: p.public_repositories_verified ?? null,
          source: p.source ?? null,
          userSuppliedStatus: suppliedRecord ? supplied.verification_status : null,
        },
        raw,
        profileSha256: hashOf(raw),
        resumeUrl: p.resume_url,
        resumeType: p.resume_type,
        resumeSource: resume
          ? {
              kind: resume.kind,
              sources: resume.sources,
              limitations: resume.limitations,
              limitedSource: resume.limited_source,
              githubAccountKind: resume.github_account_kind,
            }
          : null,
        resumeFile: resume?.file ?? null,
        resumeSha256: resume?.sha256 ?? null,
      });
    });
  }
  supplied.profiles.forEach((p, i) => {
    if (!matchedUrls.has(urlKey(p.github_url))) {
      issues.push(`user-supplied-profiles.json: profiles.${i}: no matching curated profile`);
    }
  });
  const candidateKeys = new Set(candidates.map((c) => c.key));
  manifest.resumes.forEach((r, i) => {
    if (!candidateKeys.has(r.key)) {
      issues.push(`resumes/manifest.json: resumes.${i}.key: no candidate with this key`);
    }
  });

  if (issues.length > 0) throw new DemoImportError(issues);
  return { employers, jobs, candidates };
}

// ---- Phase A: files ----

export interface DemoBundle {
  data: DemoData;
  /** PDF bytes by candidate key; every manifest entry exists and matches its recorded hash. */
  pdfs: ReadonlyMap<string, Uint8Array>;
}

const readJson = (path: string, name: string, issues: string[]): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    issues.push(`${name}: missing or not valid JSON`);
    return undefined;
  }
};

/** Reads and validates every fixture under the repository root; writes nothing. */
export function readDemoFiles(root: string): DemoBundle {
  const at = (path: string) => resolve(root, path);
  const issues: string[] = [];
  const files = {
    employers: readJson(at('data/demo/employers/employers.json'), 'employers.json', issues),
    jobs: readJson(at('data/demo/employers/jobs.json'), 'jobs.json', issues),
    curated: readJson(
      at('data/demo/public-developers/curated-profiles.json'),
      'curated-profiles.json',
      issues,
    ),
    userSupplied: readJson(
      at('data/demo/public-developers/user-supplied-profiles.json'),
      'user-supplied-profiles.json',
      issues,
    ),
    manifest: readJson(at('data/demo/resumes/manifest.json'), 'resumes/manifest.json', issues),
    postings: readJson(
      at('data/demo/employers/full-postings.json'),
      'full-postings.json',
      issues,
    ),
  };
  if (issues.length > 0) throw new DemoImportError(issues);
  const data = validateDemoData(files);

  const resumeDir = at('data/demo/resumes') + sep;
  const pdfs = new Map<string, Uint8Array>();
  for (const c of data.candidates) {
    if (c.resumeFile) {
      const path = at(c.resumeFile);
      if (!path.startsWith(resumeDir))
        issues.push(`resumes/manifest.json: ${c.key}: file outside resumes`);
      else if (!existsSync(path)) issues.push(`resumes/manifest.json: ${c.key}: file is missing`);
      else {
        const bytes = new Uint8Array(readFileSync(path));
        if (createHash('sha256').update(bytes).digest('hex') !== c.resumeSha256) {
          issues.push(`resumes/manifest.json: ${c.key}: file does not match its recorded sha256`);
        } else pdfs.set(c.key, bytes);
      }
    }
  }
  if (issues.length > 0) throw new DemoImportError(issues);
  return { data, pdfs };
}

/** Extracts each PDF whose hash differs from the stored one; unchanged files reuse stored text. */
export async function extractChangedResumes(
  bundle: DemoBundle,
  stored: ReadonlyMap<string, string | null>,
): Promise<Map<string, ResumeExtraction>> {
  const out = new Map<string, ResumeExtraction>();
  for (const c of bundle.data.candidates) {
    const bytes = bundle.pdfs.get(c.key);
    if (bytes && stored.get(c.key) !== c.resumeSha256) out.set(c.key, await extractResume(bytes));
  }
  return out;
}

export async function storedResumeHashes(keys: string[]): Promise<Map<string, string | null>> {
  if (keys.length === 0) return new Map();
  const rows = await db
    .select({ key: demoCandidates.key, sha: demoCandidates.resumePdfSha256 })
    .from(demoCandidates)
    .where(inArray(demoCandidates.key, keys));
  return new Map(rows.map((r) => [r.key, r.sha]));
}

// ---- Phase B: one transaction, changed fields only ----

export interface ImportStats {
  inserted: number;
  updated: number;
  unchanged: number;
}
const emptyStats = (): ImportStats => ({ inserted: 0, updated: 0, unchanged: 0 });

const activePending = (row: { runStatus: string; runHeartbeatAt: Date | null }) =>
  row.runStatus === 'pending' &&
  row.runHeartbeatAt !== null &&
  row.runHeartbeatAt.getTime() > Date.now() - RUN_STALE_MS;

function resumeFields(extraction: ResumeExtraction | undefined, sha: string | null) {
  if (sha === null) {
    return {
      resumePdfSha256: null,
      resumeStatus: 'none' as const,
      resumeReviewReason: null,
      resumePages: null,
      resumeText: null,
    };
  }
  if (!extraction) throw new DemoImportError(['A resume changed during the import; run it again']);
  return extraction.status === 'extracted'
    ? {
        resumePdfSha256: sha,
        resumeStatus: 'extracted' as const,
        resumeReviewReason: null,
        resumePages: extraction.pages,
        resumeText: extraction.text,
      }
    : {
        resumePdfSha256: sha,
        resumeStatus: 'needs_review' as const,
        resumeReviewReason: extraction.reason,
        resumePages: extraction.pages,
        resumeText: null,
      };
}

export async function importDemoData(
  bundle: DemoBundle,
  extractions: ReadonlyMap<string, ResumeExtraction>,
): Promise<{
  employers: ImportStats;
  jobs: ImportStats;
  candidates: ImportStats;
  overridesCleared: number;
}> {
  const { employers, jobs, candidates } = bundle.data;
  return db.transaction(async (tx) => {
    const stats = {
      employers: emptyStats(),
      jobs: emptyStats(),
      candidates: emptyStats(),
      overridesCleared: 0,
    };
    const blocked: string[] = [];
    const now = new Date();

    const oldEmployers = new Map(
      (
        await tx
          .select()
          .from(demoEmployers)
          .where(
            inArray(
              demoEmployers.id,
              employers.map((e) => e.id),
            ),
          )
          .for('update')
      ).map((r) => [r.id, r]),
    );
    for (const e of employers) {
      const old = oldEmployers.get(e.id);
      const fields = {
        name: e.name,
        description: e.description,
        url: e.url,
        location: e.location,
        raw: e.raw,
        recordSha256: e.recordSha256,
      };
      if (!old) {
        await tx.insert(demoEmployers).values({ id: e.id, ...fields });
        stats.employers.inserted++;
      } else if (old.recordSha256 !== e.recordSha256) {
        await tx
          .update(demoEmployers)
          .set({ ...fields, updatedAt: now })
          .where(eq(demoEmployers.id, e.id));
        stats.employers.updated++;
      } else stats.employers.unchanged++;
    }

    const oldJobs = new Map(
      (
        await tx
          .select()
          .from(demoJobs)
          .where(
            inArray(
              demoJobs.id,
              jobs.map((j) => j.id),
            ),
          )
          .for('update')
      ).map((r) => [r.id, r]),
    );
    for (const j of jobs) {
      const old = oldJobs.get(j.id);
      const display = {
        location: j.location,
        sourceUrl: j.sourceUrl,
        sourceChecked: j.sourceChecked,
        scenario: j.scenario,
        inScope: j.inScope,
        retrievedOn: j.retrievedOn,
        sourceLimitations: j.sourceLimitations,
        raw: j.raw,
        recordSha256: j.recordSha256,
      };
      const input = {
        employerId: j.employerId,
        title: j.title,
        text: j.text,
        textSource: j.textSource,
        inputSha256: j.inputSha256,
      };
      if (!old) {
        await tx.insert(demoJobs).values({ id: j.id, ...display, ...input });
        stats.jobs.inserted++;
        continue;
      }
      const recordChanged = old.recordSha256 !== j.recordSha256;
      const inputChanged = old.inputSha256 !== j.inputSha256;
      const postingChanged = inputChanged || old.sourceUrl !== j.sourceUrl;
      if (!recordChanged && !inputChanged) {
        stats.jobs.unchanged++;
        continue;
      }
      if (activePending(old)) blocked.push(`job ${j.id}`);
      await tx
        .update(demoJobs)
        .set({ ...(recordChanged && display), ...(inputChanged && input), updatedAt: now })
        .where(eq(demoJobs.id, j.id));
      // A different posting or analysed input makes its priorities meaningless.
      if (postingChanged) {
        const cleared = await tx
          .delete(jobPriorityOverrides)
          .where(eq(jobPriorityOverrides.jobKey, j.id))
          .returning({ skillId: jobPriorityOverrides.skillId });
        stats.overridesCleared += cleared.length;
      }
      stats.jobs.updated++;
    }

    const oldCandidates = new Map(
      (
        await tx
          .select()
          .from(demoCandidates)
          .where(
            inArray(
              demoCandidates.key,
              candidates.map((c) => c.key),
            ),
          )
          .for('update')
      ).map((r) => [r.key, r]),
    );
    for (const c of candidates) {
      const old = oldCandidates.get(c.key);
      const profile = {
        name: c.name,
        githubUrl: c.githubUrl,
        githubLogin: c.githubLogin,
        organization: c.organization,
        repositories: c.repositories,
        verification: c.verification,
        raw: c.raw,
        profileSha256: c.profileSha256,
        resumeUrl: c.resumeUrl,
        resumeType: c.resumeType,
        resumeSource: c.resumeSource,
      };
      if (!old) {
        await tx.insert(demoCandidates).values({
          key: c.key,
          ...profile,
          ...resumeFields(extractions.get(c.key), c.resumeSha256),
        });
        stats.candidates.inserted++;
        continue;
      }
      const profileChanged =
        old.profileSha256 !== c.profileSha256 ||
        old.organization !== c.organization ||
        canonicalJson(old.resumeSource) !== canonicalJson(c.resumeSource);
      const resumeChanged = old.resumePdfSha256 !== c.resumeSha256;
      if (!profileChanged && !resumeChanged) {
        stats.candidates.unchanged++;
        continue;
      }
      if (activePending(old)) blocked.push(`candidate ${c.key}`);
      await tx
        .update(demoCandidates)
        .set({
          ...(profileChanged && profile),
          ...(resumeChanged && resumeFields(extractions.get(c.key), c.resumeSha256)),
          updatedAt: now,
        })
        .where(eq(demoCandidates.key, c.key));
      stats.candidates.updated++;
    }

    if (blocked.length > 0) {
      throw new DemoImportError(
        blocked.map((s) => `${s} has a running analysis; retry the import later`),
      );
    }
    return stats;
  });
}
