import { createHash, randomUUID } from 'node:crypto';
import { eq, inArray, like, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { db, databaseIsUp, pool } from '../db/client.js';
import {
  demoCandidates,
  demoEmployers,
  demoJobs,
  jobPriorityOverrides,
  users,
} from '../db/schema.js';
import {
  DemoImportError,
  extractChangedResumes,
  importDemoData,
  storedResumeHashes,
  validateDemoData,
  type DemoBundle,
} from './demo-import.js';
import { makePdf, resumeText } from './test-pdf.js';

// Real Postgres; every row is scoped to this run, so the imported demo data is never touched.
const RUN = `test-${randomUUID()}`;
const EMPLOYER = `${RUN}-acme`;
const JOB = `${RUN}-job`;
const OTHER_JOB = `${RUN}-job-2`;
const CAND = `${RUN}-cand`;
const BARE = `${RUN}-bare`;
const up = await databaseIsUp();

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const PDF = makePdf([resumeText('Ada')]);

interface Options {
  pdf?: Uint8Array | null;
  jobLines?: string[];
  sourceUrl?: string;
  employerName?: string;
  /** Retrieved posting text for JOB; absent means only the research notes exist. */
  posting?: string;
  note?: string;
}

function bundle(o: Options = {}): DemoBundle {
  const pdf = o.pdf === undefined ? PDF : o.pdf;
  const files = {
    employers: [
      {
        id: EMPLOYER,
        name: o.employerName ?? 'Acme',
        description: 'Tools',
        url: 'https://acme.test',
      },
    ],
    jobs: [
      {
        id: JOB,
        employer_id: EMPLOYER,
        title: 'Engineer',
        requirements_summary: o.jobLines ?? ['TypeScript services'],
        source_url: o.sourceUrl ?? 'https://acme.test/jobs/1',
        scenario: 'possible_skill_overlap',
      },
      {
        id: OTHER_JOB,
        employer_id: EMPLOYER,
        title: 'Nurse',
        requirements_summary: ['Patient care'],
        source_url: 'https://acme.test/jobs/2',
        scenario: 'out_of_scope_negative_control',
      },
    ],
    curated: {
      profiles: [
        {
          id: CAND,
          name: 'Ada',
          github_url: 'https://github.com/cand',
          resume_url: 'https://ada.test/cv.pdf',
          resume_type: 'pdf',
          selected_repositories: [{ full_name: 'octo/one', pinned_commit_sha: 'a'.repeat(40) }],
          ...(o.note && { note: o.note }),
        },
      ],
      user_profiles_without_resume: [
        {
          id: BARE,
          name: 'Bare',
          github_url: 'https://github.com/bare-account',
          resume_url: null,
          resume_type: null,
          selected_repositories: [],
        },
      ],
    },
    userSupplied: { verification_status: 'unverified', profiles: [] },
    manifest: {
      version: 1,
      resumes: pdf
        ? [
            {
              key: CAND,
              kind: 'original_public_resume',
              sources: ['https://ada.test/cv.pdf'],
              limitations: [],
              file: 'data/demo/resumes/ada.pdf',
              sha256: sha(pdf),
              limited_source: false,
              github_account_kind: 'user',
            },
          ]
        : [],
    },
    postings: {
      retrievedOn: '2026-11-03',
      postings: o.posting
        ? [
            {
              id: JOB,
              sourceUrl: o.sourceUrl ?? 'https://acme.test/jobs/1',
              sourceStatus: 'full_description',
              sourceText: o.posting,
            },
          ]
        : [],
    },
  };
  return { data: validateDemoData(files), pdfs: new Map(pdf ? [[CAND, pdf]] : []) };
}

async function runImport(b: DemoBundle) {
  const stored = await storedResumeHashes(b.data.candidates.map((c) => c.key));
  const extractions = await extractChangedResumes(b, stored);
  return { extractions, stats: await importDemoData(b, extractions) };
}

const candidateRow = async () =>
  (await db.select().from(demoCandidates).where(eq(demoCandidates.key, CAND)))[0]!;

afterAll(async () => {
  if (up) {
    await db.delete(jobPriorityOverrides).where(like(jobPriorityOverrides.jobKey, `${RUN}%`));
    await db.delete(demoJobs).where(like(demoJobs.id, `${RUN}%`));
    await db.delete(demoEmployers).where(like(demoEmployers.id, `${RUN}%`));
    await db.delete(demoCandidates).where(like(demoCandidates.key, `${RUN}%`));
  }
  await pool.end();
});

describe.runIf(up)('importDemoData (Postgres)', () => {
  it('imports once, then writes and extracts nothing when inputs are unchanged', async () => {
    const usersBefore = (await db.select({ n: sql<number>`count(*)::int` }).from(users))[0]!.n;
    const first = await runImport(bundle());
    expect(first.stats.candidates.inserted).toBe(2);
    expect(first.extractions.size).toBe(1);
    expect(await candidateRow()).toMatchObject({
      resumeStatus: 'extracted',
      resumeSource: { kind: 'original_public_resume' },
    });
    const [bare] = await db.select().from(demoCandidates).where(eq(demoCandidates.key, BARE));
    expect(bare).toMatchObject({ resumeStatus: 'none', resumeText: null });
    const [nurse] = await db.select().from(demoJobs).where(eq(demoJobs.id, OTHER_JOB));
    expect(nurse).toMatchObject({ inScope: false, textSource: 'fixture_summary' });

    const again = await runImport(bundle());
    expect(again.extractions.size).toBe(0);
    for (const table of ['employers', 'jobs', 'candidates'] as const) {
      expect(again.stats[table]).toMatchObject({ inserted: 0, updated: 0 });
    }
    const usersAfter = (await db.select({ n: sql<number>`count(*)::int` }).from(users))[0]!.n;
    expect(usersAfter).toBe(usersBefore);
  });

  it('re-extracts a replaced PDF and clears text when its manifest entry is removed', async () => {
    const replaced = makePdf([resumeText('Grace')]);
    const { stats } = await runImport(bundle({ pdf: replaced}));
    expect(stats.candidates.updated).toBe(1);
    const row = await candidateRow();
    expect(row.resumePdfSha256).toBe(sha(replaced));
    expect(row.resumeText).toContain('Grace');

    await runImport(bundle({ pdf: null}));
    expect(await candidateRow()).toMatchObject({
      resumeStatus: 'none',
      resumePdfSha256: null,
      resumeText: null,
      resumeSource: null,
    });
    await runImport(bundle());
  });

  it('imports retrieved posting text and clears overrides when it replaces the notes', async () => {
    await db
      .insert(jobPriorityOverrides)
      .values({ jobKey: JOB, skillId: 'api-design', priority: 3 });
    const { stats } = await runImport(bundle({ posting: 'Build TypeScript services.' }));
    expect(stats.overridesCleared).toBe(1);
    const [job] = await db.select().from(demoJobs).where(eq(demoJobs.id, JOB));
    expect(job).toMatchObject({
      text: 'Build TypeScript services.',
      textSource: 'full_description',
      retrievedOn: '2026-11-03',
      sourceLimitations: [],
    });
    await runImport(bundle());
  });

  it('clears priority overrides when only the posting URL changes', async () => {
    await db
      .insert(jobPriorityOverrides)
      .values({ jobKey: JOB, skillId: 'api-design', priority: 3 });
    const { stats } = await runImport(
      bundle({ sourceUrl: 'https://acme.test/jobs/1b'}),
    );
    expect(stats.overridesCleared).toBe(1);
    await runImport(bundle());
  });

  it('clears priority overrides only for postings whose analysed input changed', async () => {
    await db.insert(jobPriorityOverrides).values([
      { jobKey: JOB, skillId: 'unit-testing', priority: 3 },
      { jobKey: OTHER_JOB, skillId: 'unit-testing', priority: 1 },
    ]);
    const { stats } = await runImport(bundle({ jobLines: ['Go services']}));
    expect(stats.overridesCleared).toBe(1);
    const left = await db
      .select()
      .from(jobPriorityOverrides)
      .where(inArray(jobPriorityOverrides.jobKey, [JOB, OTHER_JOB]));
    expect(left.map((o) => o.jobKey)).toEqual([OTHER_JOB]);
  });

  it('rejects changes to a subject with a running analysis and rolls everything back', async () => {
    await db
      .update(demoCandidates)
      .set({ runStatus: 'pending', runId: randomUUID(), runHeartbeatAt: new Date() })
      .where(eq(demoCandidates.key, CAND));
    const changed = bundle({
      note: 'edited',
      employerName: 'Acme Renamed',
      jobLines: ['Go services'],
    });
    await expect(runImport(changed)).rejects.toBeInstanceOf(DemoImportError);
    const [employer] = await db.select().from(demoEmployers).where(eq(demoEmployers.id, EMPLOYER));
    expect(employer!.name).toBe('Acme');
    await db
      .update(demoCandidates)
      .set({ runStatus: 'idle', runId: null })
      .where(eq(demoCandidates.key, CAND));
  });
});
