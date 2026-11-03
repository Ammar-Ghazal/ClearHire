// Plain test screen for the demo pipeline: pick a candidate and a job, start analyses, inspect
// per-repository evidence, adjust priorities and read the server's match. No charts, no editing.
import type {
  DemoCandidate,
  DemoCandidateSummary,
  DemoJob,
  DemoJobSummary,
  DemoMatch,
  Freshness,
  RepositoryBreakdown,
} from '@clearhire/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiRequestError,
  getDemoCandidate,
  getDemoCandidates,
  getDemoJob,
  getDemoJobs,
  getDemoMatch,
  setJobPriority,
  startCandidateAnalysis,
  startJobAnalysis,
} from './api';

const POLL_MS = 4000;

const FRESHNESS: Record<Freshness['state'], string> = {
  current: 'Current analysis',
  pending: 'Analysis running',
  failed: 'Analysis failed',
  outdated: 'Only an analysis of older inputs exists',
  not_started: 'Not analyzed yet',
  not_applicable: 'Not analyzed',
  model_not_configured: 'Muse is not configured on the API',
};

const REPO_STATE: Record<RepositoryBreakdown['state'], string> = {
  analyzed: 'Analyzed',
  not_described: 'Analyzed, but the model reported nothing for this repository',
  no_attributed_evidence: 'No lines attributed to this account were found',
  unavailable: 'Could not be fetched from GitHub',
  pending: 'Analysis running',
  failed: 'Analysis failed',
  outdated: 'Only an analysis of older inputs exists',
  not_analyzed: 'Not analyzed yet',
};

const RESUME_KIND = {
  original_public_resume: 'original public resume',
  reconstructed_demo_resume: 'reconstructed demo resume',
} as const;

const errorCode = (err: unknown) => (err instanceof ApiRequestError ? err.code : 'request_failed');

/** Ignores responses that arrive after the selection they were requested for has changed. */
function useLatest() {
  const counter = useRef(0);
  return useCallback(() => {
    const id = ++counter.current;
    return () => id === counter.current;
  }, []);
}

export function DemoScreen({ isOperator }: { isOperator: boolean }) {
  const [candidates, setCandidates] = useState<DemoCandidateSummary[]>([]);
  const [jobs, setJobs] = useState<DemoJobSummary[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [candidateKey, setCandidateKey] = useState('');
  const [jobId, setJobId] = useState('');
  const [candidate, setCandidate] = useState<DemoCandidate | null>(null);
  const [job, setJob] = useState<DemoJob | null>(null);
  const [match, setMatch] = useState<DemoMatch | null>(null);
  const [candidateNote, setCandidateNote] = useState<string | null>(null);
  const [jobNote, setJobNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const latestCandidate = useLatest();
  const latestJob = useLatest();
  const latestMatch = useLatest();
  // The current selections, read by action handlers whose response may arrive after a change.
  const selectedCandidate = useRef('');
  const selectedJob = useRef('');

  useEffect(() => {
    Promise.all([getDemoCandidates(), getDemoJobs()])
      .then(([c, j]) => {
        setCandidates(c);
        setJobs(j);
      })
      .catch((err) => setListError(errorCode(err)));
  }, []);

  const loadCandidate = useCallback(
    async (key: string) => {
      const isLatest = latestCandidate();
      if (!key) return setCandidate(null);
      try {
        const detail = await getDemoCandidate(key);
        if (isLatest()) setCandidate(detail);
      } catch (err) {
        if (isLatest()) setCandidateNote(errorCode(err));
      }
    },
    [latestCandidate],
  );

  const loadJob = useCallback(
    async (id: string) => {
      const isLatest = latestJob();
      if (!id) return setJob(null);
      try {
        const detail = await getDemoJob(id);
        if (isLatest()) setJob(detail);
      } catch (err) {
        if (isLatest()) setJobNote(errorCode(err));
      }
    },
    [latestJob],
  );

  const loadMatch = useCallback(async () => {
    const isLatest = latestMatch();
    if (!candidateKey || !jobId) return setMatch(null);
    try {
      const result = await getDemoMatch(candidateKey, jobId);
      if (isLatest()) setMatch(result);
    } catch {
      if (isLatest()) setMatch(null);
    }
  }, [candidateKey, jobId, latestMatch]);

  // A new selection clears everything derived from the previous one.
  useEffect(() => {
    selectedCandidate.current = candidateKey;
    setCandidate(null);
    setCandidateNote(null);
    void loadCandidate(candidateKey);
  }, [candidateKey, loadCandidate]);

  useEffect(() => {
    selectedJob.current = jobId;
    setJob(null);
    setJobNote(null);
    void loadJob(jobId);
  }, [jobId, loadJob]);

  useEffect(() => {
    setMatch(null);
    void loadMatch();
  }, [loadMatch, candidate?.freshness.state, job?.freshness.state, job?.requirements]);

  // Poll only while a run is queued or pending.
  const active = (run: DemoJob['run'] | undefined) =>
    run?.status === 'queued' || run?.status === 'pending';
  const candidatePending = active(candidate?.run);
  const jobPending = active(job?.run);
  useEffect(() => {
    if (!candidatePending && !jobPending) return;
    const timer = setInterval(() => {
      if (candidatePending) void loadCandidate(candidateKey);
      if (jobPending) void loadJob(jobId);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [candidatePending, jobPending, candidateKey, jobId, loadCandidate, loadJob]);

  // Notes and reloads apply only if the same candidate or job is still selected.
  /** `regrade` is an explicit fresh run: it never reuses a saved result. */
  async function analyzeCandidate(regrade: boolean) {
    const key = candidateKey;
    const selected = () => selectedCandidate.current === key;
    setBusy('candidate');
    setCandidateNote(null);
    try {
      const { result } = await startCandidateAnalysis(key, regrade);
      if (selected()) {
        setCandidateNote(result === 'cached' ? 'Cached result reused; no new request made.' : null);
      }
    } catch (err) {
      if (selected()) setCandidateNote(errorCode(err));
    } finally {
      setBusy(null);
      if (selected()) void loadCandidate(key);
    }
  }

  async function analyzeJob(regrade: boolean) {
    const id = jobId;
    const selected = () => selectedJob.current === id;
    setBusy('job');
    setJobNote(null);
    try {
      const { result } = await startJobAnalysis(id, regrade);
      if (selected()) {
        setJobNote(result === 'cached' ? 'Cached result reused; no new request made.' : null);
      }
    } catch (err) {
      if (selected()) setJobNote(errorCode(err));
    } finally {
      setBusy(null);
      if (selected()) void loadJob(id);
    }
  }

  async function changePriority(skillId: string, priority: number | null) {
    const id = jobId;
    const selected = () => selectedJob.current === id;
    setBusy(`priority:${skillId}`);
    const isLatest = latestJob();
    try {
      const updated = await setJobPriority(id, skillId, priority);
      if (isLatest() && selected()) setJob(updated);
    } catch (err) {
      if (isLatest() && selected()) setJobNote(errorCode(err));
    } finally {
      setBusy(null);
    }
  }

  if (listError) return <Notice tone="error">Demo data could not be loaded ({listError}).</Notice>;

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <label className="block text-sm font-medium text-slate-700">
          Candidate
          <select
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={candidateKey}
            onChange={(e) => setCandidateKey(e.target.value)}
          >
            <option value="">Choose a demo candidate…</option>
            {candidates.map((c) => (
              <option key={c.key} value={c.key}>
                {c.name} (@{c.githubLogin}) ·{' '}
                {c.repositoryCount === null ? 'repos not chosen yet' : `${c.repositoryCount} repo(s)`}
              </option>
            ))}
          </select>
        </label>
        {candidate && (
          <CandidatePanel
            candidate={candidate}
            isOperator={isOperator}
            busy={busy === 'candidate'}
            note={candidateNote}
            onAnalyze={analyzeCandidate}
          />
        )}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <label className="block text-sm font-medium text-slate-700">
          Job
          <select
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={jobId}
            onChange={(e) => setJobId(e.target.value)}
          >
            <option value="">Choose a demo job…</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.id}: {j.title} · {j.employer.name}
                {j.inScope ? '' : ' (out of scope)'}
              </option>
            ))}
          </select>
        </label>
        {job && (
          <JobPanel
            job={job}
            isOperator={isOperator}
            busy={busy}
            note={jobNote}
            onAnalyze={analyzeJob}
            onPriority={changePriority}
          />
        )}
      </section>

      {candidateKey && jobId && <MatchPanel match={match} />}
    </div>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: 'info' | 'warn' | 'error';
  children: React.ReactNode;
}) {
  const styles = {
    info: 'border-slate-200 bg-slate-50 text-slate-700',
    warn: 'border-amber-200 bg-amber-50 text-amber-800',
    error: 'border-red-200 bg-red-50 text-red-800',
  };
  return <div className={`rounded-md border px-3 py-2 text-sm ${styles[tone]}`}>{children}</div>;
}

function StatusLine({ freshness, run }: { freshness: Freshness; run: DemoJob['run'] }) {
  return (
    <p className="text-sm text-slate-600">
      {FRESHNESS[freshness.state]}
      {freshness.assessmentStatus && freshness.assessmentStatus !== 'complete'
        ? ` (${freshness.assessmentStatus.replaceAll('_', ' ')})`
        : ''}
      {freshness.errorCode ? ` · ${freshness.errorCode}` : ''}
      {run.status === 'queued' ? ' · queued' : ''}
      {run.status === 'pending' ? ' · run in progress' : ''}
      {run.status === 'failed' ? ` · last run failed: ${run.errorCode ?? 'unknown'}` : ''}
    </p>
  );
}

function ActionRow(props: {
  isOperator: boolean;
  disabled: boolean;
  busy: boolean;
  note: string | null;
  onAnalyze: (regrade: boolean) => void;
}) {
  if (!props.isOperator) return null;
  const button =
    'rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50';
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        className={`${button} bg-slate-900 text-white hover:bg-slate-700`}
        disabled={props.disabled || props.busy}
        onClick={() => props.onAnalyze(false)}
      >
        Analyze
      </button>
      <button
        className={`${button} border border-slate-300 hover:bg-slate-100`}
        disabled={props.disabled || props.busy}
        onClick={() => props.onAnalyze(true)}
      >
        Regrade
      </button>
      {props.note && <span className="text-sm text-slate-600">{props.note}</span>}
    </div>
  );
}

function CandidatePanel(props: {
  candidate: DemoCandidate;
  isOperator: boolean;
  busy: boolean;
  note: string | null;
  onAnalyze: (regrade: boolean) => void;
}) {
  const { candidate } = props;
  const { resume } = candidate;
  const blocked =
    candidate.organization ||
    candidate.repositoryCount === 0 ||
    candidate.freshness.state === 'model_not_configured';
  return (
    <div className="mt-4 space-y-4">
      <div className="space-y-1 text-sm">
        <p>
          <a className="text-blue-700 underline" href={candidate.githubUrl}>
            GitHub @{candidate.githubLogin}
          </a>
          {candidate.organization &&
            ' · organization account: repositories are not attributed to a person'}
          {candidate.verification.identityMatchVerified === false &&
            ' · identity not independently verified'}
        </p>
        <p className="text-slate-600">
          Resume:{' '}
          {resume.status === 'none'
            ? 'none supplied'
            : resume.status === 'needs_review'
              ? `needs manual review (${resume.reviewReason ?? 'unknown'})`
              : `${RESUME_KIND[resume.kind ?? 'original_public_resume']}, ${resume.pages} page(s)`}
          {resume.limitedSource && ' · limited source'}
          {' · treated as claims, never as demonstrated skills'}
        </p>
        {resume.sources.length > 0 && (
          <p className="text-slate-600">
            Sources:{' '}
            {resume.sources.map((url, i) => (
              <span key={url}>
                {i > 0 && ', '}
                <a className="text-blue-700 underline" href={url}>
                  {new URL(url).hostname}
                </a>
              </span>
            ))}
          </p>
        )}
        <StatusLine freshness={candidate.freshness} run={candidate.run} />
      </div>
      {candidate.repositoryCount === 0 && (
        <Notice tone="info">
          This profile has no public repositories to grade, so there is nothing to analyze.
        </Notice>
      )}
      <ActionRow
        isOperator={props.isOperator}
        disabled={blocked || candidate.run.status === 'pending'}
        busy={props.busy}
        note={props.note}
        onAnalyze={props.onAnalyze}
      />
      <div className="space-y-2">
        {candidate.repositories.map((repo) => (
          <RepositoryDetails key={repo.repo} repo={repo} />
        ))}
      </div>
    </div>
  );
}

function EvidenceLinks({
  evidence,
}: {
  evidence: RepositoryBreakdown['skills'][number]['evidence'];
}) {
  if (evidence.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs">
      {evidence.map((e) => (
        <li key={`${e.path}:${e.startLine}`}>
          <a className="text-blue-700 underline" href={e.url}>
            {e.path}:{e.startLine}–{e.endLine}
          </a>
          {e.attribution && e.attribution !== 'sole' && (
            <span className="text-slate-500"> · {e.attribution} attribution</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function RepositoryDetails({ repo }: { repo: RepositoryBreakdown }) {
  const analyzed = repo.state === 'analyzed' || repo.state === 'not_described';
  return (
    <details className="rounded-md border border-slate-200">
      <summary className="cursor-pointer px-3 py-2 text-sm">
        <span className="font-medium">{repo.repo}</span>
        <span className="text-slate-500"> · {REPO_STATE[repo.state]}</span>
        {repo.reason && <span className="text-slate-500"> ({repo.reason})</span>}
      </summary>
      <div className="space-y-3 border-t border-slate-200 px-3 py-3 text-sm">
        <p className="text-xs text-slate-500">
          <a className="underline" href={repo.url}>
            {repo.url}
          </a>
          {repo.commitSha && <> · snapshot {repo.commitSha.slice(0, 7)}</>}
        </p>
        {!analyzed && (
          <Notice tone={repo.state === 'failed' || repo.state === 'unavailable' ? 'warn' : 'info'}>
            {REPO_STATE[repo.state]}.
          </Notice>
        )}
        {analyzed && (
          <>
            {repo.functionality.length > 0 && (
              <div>
                <h4 className="font-medium text-slate-700">What it does</h4>
                <ul className="list-disc pl-5">
                  {repo.functionality.map((c) => (
                    <li key={c.summary}>
                      {c.summary}
                      <EvidenceLinks evidence={c.evidence} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {repo.quality.length > 0 && (
              <div>
                <h4 className="font-medium text-slate-700">Technical findings</h4>
                <ul className="list-disc pl-5">
                  {repo.quality.map((q) => (
                    <li key={q.observation}>
                      <span className={q.kind === 'concern' ? 'text-amber-800' : ''}>
                        {q.kind === 'concern' ? 'Concern: ' : 'Strength: '}
                        {q.observation}
                      </span>
                      <EvidenceLinks evidence={q.evidence} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {repo.contribution && (
              <div>
                <h4 className="font-medium text-slate-700">Attributed contribution</h4>
                <p>{repo.contribution.summary}</p>
                <EvidenceLinks evidence={repo.contribution.evidence} />
              </div>
            )}
            {repo.skills.length > 0 && (
              <div>
                <h4 className="font-medium text-slate-700">Demonstrated skills</h4>
                <ul className="space-y-2">
                  {repo.skills.map((s) => (
                    <li key={s.skillId}>
                      <span className="font-medium">{s.name}</span> · level {s.level} ·{' '}
                      {s.confidence} confidence
                      {s.levelScope === 'candidate_wide' && (
                        <span className="text-slate-500">
                          {' '}
                          · level assessed across repositories
                        </span>
                      )}
                      {s.attributionLimitations.length > 0 && (
                        <span className="text-slate-500">
                          {' '}
                          · {s.attributionLimitations.map((l) => l.replaceAll('_', ' ')).join(', ')}
                        </span>
                      )}
                      <p className="text-slate-600">{s.rationale}</p>
                      <EvidenceLinks evidence={s.evidence} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {repo.limitations.length > 0 && (
              <div>
                <h4 className="font-medium text-slate-700">Limitations of the evidence</h4>
                <ul className="list-disc pl-5 text-slate-600">
                  {repo.limitations.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </div>
            )}
            {(repo.coverage.sampled ||
              repo.coverage.attributionGaps.length > 0 ||
              repo.coverage.limitations.length > 0 ||
              repo.duplicates.length > 0) && (
              <Notice tone="info">
                {repo.coverage.sampled && (
                  <p>Evidence was sampled: {repo.coverage.omittedRanges} range(s) were not sent.</p>
                )}
                {repo.coverage.attributionGaps.length > 0 && (
                  <p>
                    Attribution may be incomplete:{' '}
                    {[
                      ...new Set(
                        repo.coverage.attributionGaps.map((g) => g.reason.replaceAll('_', ' ')),
                      ),
                    ].join(', ')}
                    .
                  </p>
                )}
                {repo.coverage.limitations.map((l) => (
                  <p key={l}>{l}</p>
                ))}
                {repo.duplicates.map((d) => (
                  <p key={d.path}>
                    {d.path} is identical to {d.duplicateOf}; its evidence is shown there.
                  </p>
                ))}
              </Notice>
            )}
          </>
        )}
      </div>
    </details>
  );
}

function JobPanel(props: {
  job: DemoJob;
  isOperator: boolean;
  busy: string | null;
  note: string | null;
  onAnalyze: (regrade: boolean) => void;
  onPriority: (skillId: string, priority: number | null) => void;
}) {
  const { job } = props;
  return (
    <div className="mt-4 space-y-4 text-sm">
      <div className="space-y-1">
        <p>
          <a className="text-blue-700 underline" href={job.employer.url}>
            {job.employer.name}
          </a>{' '}
          · {job.employer.description}
          {job.location && ` · ${job.location}`}
        </p>
        <p>
          <a className="text-blue-700 underline" href={job.sourceUrl}>
            Source posting
          </a>
          {job.sourceChecked && (
            <span className="text-slate-500"> · checked {job.sourceChecked}</span>
          )}
        </p>
        <StatusLine freshness={job.freshness} run={job.run} />
      </div>
      {!job.inScope && (
        <Notice tone="warn">
          Out of scope: this is not a software role covered by the skill catalogue, so it is neither
          analyzed nor scored.
        </Notice>
      )}
      {job.inScope && job.textSource === 'fixture_summary' && (
        <Notice tone="info">
          Abbreviated description: these are research notes, not the full posting, so matches are
          provisional.
        </Notice>
      )}
      <pre className="whitespace-pre-wrap rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-700">
        {job.text}
      </pre>
      <ActionRow
        isOperator={props.isOperator}
        disabled={
          !job.inScope ||
          job.run.status === 'pending' ||
          job.freshness.state === 'model_not_configured'
        }
        busy={props.busy === 'job'}
        note={props.note}
        onAnalyze={props.onAnalyze}
      />
      {job.requirements.length > 0 && (
        <table className="w-full text-left text-sm">
          <thead className="text-slate-500">
            <tr>
              <th className="py-1 font-medium">Skill</th>
              <th className="py-1 font-medium">Level</th>
              <th className="py-1 font-medium">Priority</th>
            </tr>
          </thead>
          <tbody>
            {job.requirements.map((r) => (
              <tr key={r.skillId} className="border-t border-slate-100">
                <td className="py-1">
                  {r.name}
                  {r.referenceStatus === 'needs_review' && (
                    <span className="text-amber-700"> · source lines need review</span>
                  )}
                </td>
                <td className="py-1">{r.requiredLevel}</td>
                <td className="py-1">
                  {props.isOperator ? (
                    <span className="flex items-center gap-2">
                      <select
                        className="rounded-md border border-slate-300 px-2 py-1"
                        value={r.priority}
                        disabled={props.busy !== null}
                        onChange={(e) => props.onPriority(r.skillId, Number(e.target.value))}
                      >
                        {[0, 1, 2, 3].map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                      {r.prioritySource === 'override' && (
                        <button
                          className="text-xs text-blue-700 underline disabled:opacity-50"
                          disabled={props.busy !== null}
                          onClick={() => props.onPriority(r.skillId, null)}
                        >
                          Reset to {r.suggestedPriority}
                        </button>
                      )}
                    </span>
                  ) : (
                    <>
                      {r.priority}
                      {r.prioritySource === 'override' && (
                        <span className="text-slate-500"> (employer override)</span>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const MATCH_UNAVAILABLE = {
  candidate_not_current: 'The candidate has no current analysis, so there is no score.',
  job_not_current: 'The job has no current analysis, so there is no score.',
  no_attributed_evidence:
    'No code attributed to this candidate was found, so competency is not scored.',
} as const;

function MatchPanel({ match }: { match: DemoMatch | null }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-6 text-sm shadow-sm">
      <h2 className="text-lg font-medium">Match</h2>
      {match === null ? (
        <p className="mt-2 text-slate-500">Loading…</p>
      ) : match.availability === 'unavailable' ? (
        <p className="mt-2 text-slate-600">{MATCH_UNAVAILABLE[match.reason]}</p>
      ) : match.match.status === 'unscored' ? (
        <p className="mt-2 text-slate-600">
          Unscored:{' '}
          {match.match.reason === 'out_of_scope'
            ? 'the job is out of scope.'
            : 'every requirement has priority 0.'}
        </p>
      ) : (
        <div className="mt-2 space-y-1">
          <p>
            Compatibility{' '}
            <span className="font-semibold">{match.match.compatibility.toFixed(0)}%</span> ·
            evidence coverage{' '}
            <span className="font-semibold">{match.match.evidenceCoverage.toFixed(0)}%</span>
            {match.match.provisional && <span className="text-amber-700"> · provisional</span>}
          </p>
          <p className="text-xs text-slate-500">
            Calculated on the server from priority-weighted requirements; evidence coverage is not a
            prediction of job success.
          </p>
          <ul className="mt-2 space-y-0.5">
            {match.match.requirements.map((r) => (
              <li key={r.skillId}>
                {r.skillId} · priority {r.priority} · {r.verdict.replaceAll('_', ' ')}
                {r.candidateLevel !== null && ` (level ${r.candidateLevel} vs ${r.requiredLevel})`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
