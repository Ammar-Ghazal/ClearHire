// One-time recovery: job keys no longer include seeker-only versions (attribution and the rest), so
// postings saved under the old key would read as outdated. A saved row is moved to the new key only
// when its old key, recomputed from today's posting and prompt, proves identical inputs and rules.
import { JobAssessmentSchema, SKILL_CATALOGUE } from '@clearhire/shared';
import { and, eq, inArray, like } from 'drizzle-orm';
import { db } from '../db/client.js';
import { demoJobs, skillAssessments } from '../db/schema.js';
import { VERIFIER_VERSION } from './assessment-verify.js';
import { cacheKeyOf, candidateVersions, jobFingerprint } from './assessments.js';
import { jobInput } from './demo-results.js';
import type { MuseModel } from './muse.js';

/** The versions every job key carried before the split: the cleaner and attribution versions were 1. */
const OLD_JOB_VERSIONS = () => ({ ...candidateVersions(), cleaner: 1, attribution: 1 });

export interface RekeyOutcome {
  id: string;
  jobKey: string;
  oldKey: string;
  newKey: string;
  /** Null when the row is reusable; otherwise why it was left untouched. */
  skipped: string | null;
}

export async function rekeyJobs(opts: {
  model: MuseModel;
  apply: boolean;
  /** Restricts to job ids with this prefix (tests). */
  prefix?: string;
}): Promise<RekeyOutcome[]> {
  const scope = opts.prefix ? like(skillAssessments.subjectKey, `${opts.prefix}%`) : undefined;
  const rows = await db
    .select()
    .from(skillAssessments)
    .where(
      and(
        scope,
        eq(skillAssessments.kind, 'job'),
        eq(skillAssessments.subjectKind, 'demo'),
        inArray(skillAssessments.status, ['complete', 'partial']),
      ),
    );
  const jobs = new Map((await db.select().from(demoJobs)).map((j) => [j.id, j]));
  const outcomes = rows.map((row): RekeyOutcome => {
    const job = jobs.get(row.subjectKey);
    const fp = job && jobFingerprint(jobInput(job), { model: opts.model });
    const out = { id: row.id, jobKey: row.subjectKey, oldKey: row.cacheKey, newKey: fp?.cacheKey ?? '' };
    const skip = (skipped: string) => ({ ...out, skipped });
    if (!job || !fp) return skip('posting_missing');
    if (!job.inScope) return skip('out_of_scope');
    if (row.cacheKey === fp.cacheKey) return skip('already_current');
    if (row.model !== opts.model) return skip('model_changed');
    if (row.verifierVersion !== VERIFIER_VERSION) return skip('verifier_changed');
    if (row.catalogueVersion !== SKILL_CATALOGUE.version) return skip('catalogue_changed');
    const old = cacheKeyOf({ kind: 'job', body: fp.body, job: fp.input }, OLD_JOB_VERSIONS());
    if (row.cacheKey !== old) return skip('inputs_or_rules_changed');
    const parsed = JobAssessmentSchema.safeParse(row.result);
    if (!parsed.success) return skip('invalid_payload');
    const r = parsed.data;
    if (r.jobKey !== job.id || r.employerId !== job.employerId || r.title !== job.title) {
      return skip('payload_mismatch');
    }
    if (r.model !== opts.model || r.textSource !== job.textSource) return skip('payload_mismatch');
    return { ...out, skipped: null };
  });
  if (opts.apply) {
    await db.transaction(async (tx) => {
      for (const o of outcomes.filter((x) => x.skipped === null)) {
        await tx
          .update(skillAssessments)
          .set({ cacheKey: o.newKey })
          .where(and(eq(skillAssessments.id, o.id), eq(skillAssessments.cacheKey, o.oldKey)));
      }
    });
  }
  return outcomes;
}
