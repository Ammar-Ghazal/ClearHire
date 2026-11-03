import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DemoImportError, readDemoFiles, validateDemoData, type DemoFiles } from './demo-import.js';
import { makePdf, resumeText } from './test-pdf.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const json = (path: string): unknown => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));

/** The committed fixtures, deep-copied so each test can alter them. */
function realFiles(): DemoFiles & Record<string, unknown> {
  return structuredClone({
    employers: json('data/demo/employers/employers.json'),
    jobs: json('data/demo/employers/jobs.json'),
    curated: json('data/demo/public-developers/curated-profiles.json'),
    userSupplied: json('data/demo/public-developers/user-supplied-profiles.json'),
    manifest: json('data/demo/resumes/manifest.json'),
    postings: json('data/demo/employers/full-postings.json'),
  });
}

type Rec = Record<string, unknown> & { [k: string]: any };
const profiles = (f: DemoFiles) => (f.curated as Rec).profiles as Rec[];
const postings = (f: DemoFiles) => (f.postings as Rec).postings as Rec[];

function issuesOf(files: DemoFiles): string[] {
  try {
    validateDemoData(files);
  } catch (err) {
    if (err instanceof DemoImportError) return err.issues;
    throw err;
  }
  return [];
}

describe('validateDemoData', () => {
  it('accepts the committed fixtures and flags exactly the five negative controls', () => {
    const data = validateDemoData(realFiles());
    expect(data.employers).toHaveLength(15);
    expect(data.jobs).toHaveLength(25);
    expect(data.candidates).toHaveLength(28);
    expect(data.jobs.filter((j) => !j.inScope).map((j) => j.id)).toEqual([
      'job-21',
      'job-22',
      'job-23',
      'job-24',
      'job-25',
    ]);
    // Every posting has retrieved content; job-24 is a paraphrase and says so.
    expect(data.jobs.filter((j) => j.textSource !== 'full_description')).toEqual([
      expect.objectContaining({
        id: 'job-24',
        textSource: 'source_summary',
        sourceLimitations: [expect.stringContaining('not verbatim')],
      }),
    ]);
    expect(data.jobs.every((j) => j.retrievedOn === '2026-11-03')).toBe(true);
    const first = data.jobs[0]!;
    expect(first.text).toBe(postings(realFiles())[0]!.sourceText);
    expect(first.text).not.toContain('Abbreviated research notes');
  });

  it('keeps established keys, resume provenance and the organization flag', () => {
    const byKey = new Map(validateDemoData(realFiles()).candidates.map((c) => [c.key, c]));
    // Login-based keys keep their case, so they still match existing prepared files.
    expect(byKey.get('H-R-Wells2')?.githubLogin).toBe('H-R-Wells2');
    expect(byKey.get('HKUDS')).toMatchObject({ organization: true, repositories: [] });
    expect(byKey.get('Skeurz')?.resumeSource).toMatchObject({
      kind: 'reconstructed_demo_resume',
      limitedSource: true,
    });
    expect(byKey.get('antfu')?.resumeSource?.kind).toBe('original_public_resume');
    const withoutResume = [...byKey.values()].filter((c) => c.resumeSha256 === null);
    expect(withoutResume.map((c) => c.key).sort()).toEqual([
      'Elkhoudrifadoua',
      'LatifaLhafidi',
      'Nwigrat',
    ]);
    expect(byKey.get('sindresorhus')?.verification.userSuppliedStatus).toBe(
      'user_supplied_not_independently_verified',
    );
  });

  it('normalises every recorded repository shape to a pinned selection', () => {
    const candidates = validateDemoData(realFiles()).candidates;
    const repos = candidates.flatMap((c) => c.repositories);
    expect(repos).toHaveLength(28);
    expect(repos.every((r) => /^[0-9a-f]{40}$/.test(r.pinnedSha ?? ''))).toBe(true);
  });

  it('prefers an explicit profile id, then github_login, over the URL login', () => {
    const files = realFiles();
    Object.assign(profiles(files)[0]!, { id: 'stable-id', github_login: 'SindreSorhus' });
    (files.manifest as Rec).resumes[0].key = 'stable-id';
    const first = validateDemoData(files).candidates[0]!;
    expect(first).toMatchObject({ key: 'stable-id', githubLogin: 'SindreSorhus' });
  });

  it('preserves unknown fields in raw and changes hashes when they change', () => {
    const files = realFiles();
    const before = validateDemoData(files).candidates[0]!;
    profiles(files)[0]!.extra_note = 'kept';
    const after = validateDemoData(files).candidates[0]!;
    expect((after.raw as Rec).curated.extra_note).toBe('kept');
    expect(after.profileSha256).not.toBe(before.profileSha256);
  });

  it('labels the research notes when a posting has no retrieved content', () => {
    const files = realFiles();
    const before = validateDemoData(files).jobs[0]!;
    postings(files).shift();
    const after = validateDemoData(files).jobs[0]!;
    expect(after).toMatchObject({ textSource: 'fixture_summary', retrievedOn: null });
    expect(after.text).toContain('Abbreviated research notes, not the full job description:');
    expect(after.inputSha256).not.toBe(before.inputSha256);
  });

  it('rejects posting content for another URL or an unknown job', () => {
    const files = realFiles();
    postings(files)[0]!.sourceUrl = 'https://example.test/other';
    postings(files).push({ ...postings(files)[1]!, id: 'job-99' });
    expect(issuesOf(files)).toEqual(
      expect.arrayContaining([
        'full-postings.json: job-01: sourceUrl differs from jobs.json source_url',
        'full-postings.json: postings.25.id: no job with this id',
      ]),
    );
  });

  it('rejects duplicate keys and identities case-insensitively, naming no values', () => {
    const files = realFiles();
    const copy = structuredClone(profiles(files)[0]!);
    copy.github_url = 'https://github.com/SINDRESORHUS';
    profiles(files).push(copy);
    const issues = issuesOf(files);
    expect(issues).toContain('curated-profiles.json: profiles.25: duplicate candidate key');
    expect(issues).toContain('curated-profiles.json: profiles.25: duplicate GitHub identity');
    expect(issues.join('\n')).not.toContain('SINDRESORHUS');
  });

  it('rejects dangling references and unknown scenarios', () => {
    const files = realFiles();
    (files.jobs as Rec[])[0]!.employer_id = 'nobody';
    (files.jobs as Rec[])[1]!.scenario = 'maybe';
    (files.userSupplied as Rec).profiles.push({ name: 'X', github_url: 'https://github.com/x-y' });
    (files.manifest as Rec).resumes[0].key = 'ghost';
    const issues = issuesOf(files);
    expect(issues.some((i) => i.startsWith('jobs.json: 1.scenario:'))).toBe(true);
    // Schema failures stop before cross-reference checks, so check those separately.
    (files.jobs as Rec[])[1]!.scenario = 'possible_skill_overlap';
    expect(issuesOf(files)).toEqual(
      expect.arrayContaining([
        'jobs.json: 0.employer_id: no employer with this id',
        'user-supplied-profiles.json: profiles.11: no matching curated profile',
        'resumes/manifest.json: resumes.0.key: no candidate with this key',
      ]),
    );
  });
});

describe('readDemoFiles', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** A copy of the fixture JSON with one generated PDF in place of the real resumes. */
  function tempRoot() {
    dir = mkdtempSync(join(tmpdir(), 'clearhire-demo-'));
    for (const sub of ['employers', 'public-developers']) {
      cpSync(join(ROOT, 'data/demo', sub), join(dir, 'data/demo', sub), { recursive: true });
    }
    mkdirSync(join(dir, 'data/demo/resumes'), { recursive: true });
    const pdf = makePdf([resumeText('Anthony')]);
    writeFileSync(join(dir, 'data/demo/resumes/antfu.pdf'), pdf);
    const manifest = json('data/demo/resumes/manifest.json') as Rec;
    manifest.resumes = manifest.resumes
      .filter((r: Rec) => r.key === 'antfu')
      .map((r: Rec) => ({ ...r, sha256: createHash('sha256').update(pdf).digest('hex') }));
    const write = () =>
      writeFileSync(join(dir!, 'data/demo/resumes/manifest.json'), JSON.stringify(manifest));
    write();
    return { root: dir, manifest, write };
  }

  it('reads PDFs whose bytes match the manifest', () => {
    const { root } = tempRoot();
    const bundle = readDemoFiles(root);
    expect([...bundle.pdfs.keys()]).toEqual(['antfu']);
    expect(bundle.data.candidates.find((c) => c.key === 'antfu')?.resumeSha256).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it('rejects a replaced PDF whose manifest hash was not updated', () => {
    const { root } = tempRoot();
    writeFileSync(join(root, 'data/demo/resumes/antfu.pdf'), makePdf([resumeText('Someone')]));
    expect(() => readDemoFiles(root)).toThrow(/antfu: file does not match its recorded sha256/);
  });

  it('rejects a listed PDF that is missing', () => {
    const { root } = tempRoot();
    rmSync(join(root, 'data/demo/resumes/antfu.pdf'));
    expect(() => readDemoFiles(root)).toThrow(/antfu: file is missing/);
  });

  it('accepts a removed manifest entry, leaving that profile without a resume', () => {
    const { root, manifest, write } = tempRoot();
    manifest.resumes = [];
    write();
    const bundle = readDemoFiles(root);
    expect(bundle.pdfs.size).toBe(0);
    expect(bundle.data.candidates.every((c) => c.resumeSha256 === null)).toBe(true);
  });
});

// Runs only where the gitignored resume PDFs have been placed locally.
const realPdfs = (() => {
  try {
    return readDemoFiles(ROOT);
  } catch {
    return undefined;
  }
})();

describe.skipIf(!realPdfs)('local resume PDFs', () => {
  it('resolves all 25 manifest entries to PDFs with matching hashes and candidate keys', () => {
    expect(realPdfs!.pdfs.size).toBe(25);
  });
});
