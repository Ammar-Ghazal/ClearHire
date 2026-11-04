import type { JudgeModelActivity } from "@clearhire/shared";
import type { MuseAttemptEvent } from "./muse.js";
import type { Octokit } from "@octokit/rest";
import { and, asc, desc, eq, inArray, ne, or } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  demoJobs,
  museCalls,
  repositorySelections,
  skillAssessments,
} from "../db/schema.js";
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

const options = {
  model: "muse-spark-1.3-contributor",
  retryFailed: true,
} as const;
const REPOSITORY_CONCURRENCY = 2;
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

/** Markers from the repositories finished since `since`, for a judge's run still in progress. */
export const liveJudgeAssessment = (key: string, since: Date) =>
  combineCandidate(subjectFor(key), null, options, since);

export async function judgeModelCalls(
  key: string,
  jobAssessmentIds: string[],
  callIds?: string[],
) {
  if (callIds?.length === 0) return [];
  const rows = await db
    .select({
      id: museCalls.id,
      model: museCalls.model,
      attempt: museCalls.attempt,
      settlement: museCalls.settlement,
      costSource: museCalls.costSource,
      reservedMicroUsd: museCalls.reservedMicroUsd,
      costMicroUsd: museCalls.costMicroUsd,
      httpStatus: museCalls.httpStatus,
      finishReason: museCalls.finishReason,
      promptTokens: museCalls.promptTokens,
      cachedTokens: museCalls.cachedTokens,
      completionTokens: museCalls.completionTokens,
      reasoningTokens: museCalls.reasoningTokens,
      latencyMs: museCalls.latencyMs,
      responseId: museCalls.responseId,
      errorCode: museCalls.errorCode,
      createdAt: museCalls.createdAt,
      settledAt: museCalls.settledAt,
      kind: skillAssessments.kind,
      repository: repositorySelections.fullName,
      jobTitle: demoJobs.title,
    })
    .from(museCalls)
    .innerJoin(
      skillAssessments,
      eq(skillAssessments.id, museCalls.assessmentId),
    )
    .leftJoin(
      repositorySelections,
      and(
        eq(repositorySelections.subjectKind, skillAssessments.subjectKind),
        eq(repositorySelections.subjectKey, skillAssessments.subjectKey),
        eq(repositorySelections.repoId, skillAssessments.repoId),
      ),
    )
    .leftJoin(
      demoJobs,
      and(
        eq(skillAssessments.kind, "job"),
        eq(demoJobs.id, skillAssessments.subjectKey),
      ),
    )
    .where(
      and(
        callIds ? inArray(museCalls.id, callIds) : undefined,
        or(
          and(
            eq(skillAssessments.subjectKind, "user"),
            eq(skillAssessments.subjectKey, key),
          ),
          jobAssessmentIds.length > 0
            ? and(
                eq(skillAssessments.kind, "job"),
                inArray(skillAssessments.id, jobAssessmentIds),
              )
            : undefined,
        ),
      ),
    )
    .orderBy(desc(museCalls.createdAt), desc(museCalls.id))
    .limit(callIds?.length ?? 50);
  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    settledAt: row.settledAt?.toISOString() ?? null,
  }));
}

export function trackJudgeAttempt(
  activity: Map<string, JudgeModelActivity>,
  kind: JudgeModelActivity["kind"],
  target: string,
  event: MuseAttemptEvent,
) {
  const now = new Date().toISOString();
  if (event.phase === "queued") {
    activity.set(event.id, {
      id: event.id,
      model: event.model,
      attempt: event.attempt,
      kind,
      target,
      queuedAt: now,
      callId: null,
      sentAt: null,
      receivedAt: null,
      failed: false,
    });
    return;
  }
  const entry = activity.get(event.id);
  if (!entry) return;
  if (event.phase === "sent") {
    entry.callId = event.callId;
    entry.sentAt = now;
  } else if (event.phase === "received") {
    entry.receivedAt = now;
  } else {
    entry.failed = true;
  }
}

export async function gradeJudge(
  key: string,
  octokit: Octokit,
  identity: CandidateIdentity,
  selection: Awaited<ReturnType<typeof activeSelection>>,
  onJobStarted: (assessmentId: string) => void,
  activity: Map<string, JudgeModelActivity>,
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

  const gradeRepository = async (repo: (typeof selection)[number]) => {
    try {
      await processRepository(
        octokit,
        {
          subject,
          identity,
          resumeText: null,
          dataUse: "approved_public_demo",
          publicOnly: true,
        },
        repo,
        { fresh: true, automatic: false },
        {
          ...options,
          onAttempt: (event) =>
            trackJudgeAttempt(activity, "repository", repo.fullName, event),
        },
      );
    } catch (err) {
      noteQuota(err);
      await recordFailure(repo, safeErrorCode(err));
      throw err;
    }
  };
  // Worker pool: a free worker takes the next repository without waiting for a whole batch.
  const queue = [...selection];
  const workers = Array.from({ length: REPOSITORY_CONCURRENCY }, async () => {
    for (let repo = queue.shift(); repo; repo = queue.shift()) {
      await gradeRepository(repo).catch((err: unknown) => {
        queue.length = 0; // stop starting new repositories after a failure
        throw err;
      });
    }
  });
  const failure = (await Promise.allSettled(workers)).find(
    (result) => result.status === "rejected",
  );
  if (failure) throw failure.reason;
  await combineCandidate(subject, null, options);
  await analyzeJob(
    { ...jobInput(job), dataUse: "approved_public_demo" },
    {
      ...options,
      onAttempt: (event) =>
        trackJudgeAttempt(activity, "job", job.title, event),
    },
    onJobStarted,
  );
}
