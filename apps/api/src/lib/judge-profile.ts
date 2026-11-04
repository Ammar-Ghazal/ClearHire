import type { Octokit } from "@octokit/rest";
import { and, asc, eq, ne } from "drizzle-orm";
import { db } from "../db/client.js";
import { demoJobs } from "../db/schema.js";
import {
  activeSelection,
  analyzeJob,
  assessmentByFingerprint,
  combineCandidate,
  combinedKey,
  matchSaved,
  recoverStaleAssessments,
} from "./assessments.js";
import type { CandidateIdentity } from "./attribution.js";
import { jobInput } from "./demo-results.js";
import { safeErrorCode } from "./demo-runner.js";
import {
  noteQuota,
  processRepository,
  recordFailure,
} from "./repository-runs.js";

const options = { model: "muse-spark-1.3", retryFailed: true } as const;
const subjectFor = (key: string) => ({ kind: "user" as const, key });

async function sampleJob() {
  const [job] = await db
    .select()
    .from(demoJobs)
    .where(
      and(
        eq(demoJobs.inScope, true),
        ne(demoJobs.textSource, "fixture_summary"),
      ),
    )
    .orderBy(asc(demoJobs.id))
    .limit(1);
  return job;
}

export async function judgeProfile(key: string) {
  const subject = subjectFor(key);
  const selection = await activeSelection(subject);
  const job = await sampleJob();
  const result =
    selection.length > 0
      ? await assessmentByFingerprint(
          "candidate",
          subject,
          combinedKey(
            subject,
            options.model,
            selection.map((repo) => repo.repoId),
          ),
        )
      : null;
  const assessment = result?.state === "current" ? result.assessment : null;
  let match = null;
  if (assessment && assessment.status !== "no_attributed_evidence" && job) {
    try {
      match = await matchSaved(subject, job.id, options);
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
    }
  }
  return { assessment, match, jobTitle: job?.title ?? null };
}

export async function gradeJudge(
  key: string,
  octokit: Octokit,
  identity: CandidateIdentity,
  selection: Awaited<ReturnType<typeof activeSelection>>,
) {
  const subject = subjectFor(key);
  const job = await sampleJob();
  if (!job)
    throw new Error("Load the demo seed to make a sample posting available");
  for (const kind of ["candidate", "repository"] as const) {
    await recoverStaleAssessments({
      kind,
      subjectKind: subject.kind,
      subjectKey: key,
    });
  }
  await recoverStaleAssessments({
    kind: "job",
    subjectKind: "demo",
    subjectKey: job.id,
  });

  for (const repo of selection) {
    try {
      await processRepository(
        octokit,
        {
          subject,
          identity,
          resumeText: null,
          dataUse: "restricted",
          publicOnly: true,
        },
        repo,
        { fresh: false, automatic: false },
        options,
      );
    } catch (err) {
      noteQuota(err);
      await recordFailure(repo, safeErrorCode(err));
      throw err;
    }
  }
  await combineCandidate(subject, null, options);
  await analyzeJob(
    { ...jobInput(job), dataUse: "approved_public_demo" },
    options,
  );
}
