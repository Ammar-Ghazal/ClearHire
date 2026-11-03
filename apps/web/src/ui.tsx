// Small pieces shared by the pages: loading, actions, errors, stage chips and score summaries.
import type { DemoJob, DemoSide, MatchSummary, RelationshipStage, Score } from '@clearhire/shared';
import { Link } from 'react-router';
import { useEffect, useState, type ReactNode } from 'react';
import { ApiRequestError } from './api';
import { Badge } from './components/ui/badge';
import { SCORE_LABELS, STAGES, TEXT_SOURCES, percent, stageLabel } from './status';

const ERRORS: Record<string, string> = {
  job_not_current: 'This posting needs a current analysis before priorities can change.',
  invalid_transition: 'This answer can no longer be changed.',
  invalid_stage: 'This match has moved on. Refresh to see its current stage.',
  discussion_closed: 'Discussion is not open for this match.',
  interview_confirmed: 'A time is already confirmed.',
  offer_frozen: 'A shared offer cannot be changed.',
  in_progress: 'An analysis is already running.',
  organization_account: 'Organization accounts are not graded as a person.',
  no_selected_repositories: 'This profile has no selected repositories to grade.',
  model_not_configured: 'Analysis is not configured on the server.',
  invalid_input: 'Check the highlighted values and try again.',
  not_found: 'This item is not available to the current demo identity.',
  unauthenticated: 'Only the posting’s employer or a signed-in demo operator can do this.',
  forbidden: 'Only the posting’s employer or a demo operator can do this.',
};

export const errorText = (err: unknown) => {
  const code = err instanceof ApiRequestError ? err.code : 'request_failed';
  return ERRORS[code] ?? `Something went wrong (${code}).`;
};

/** Loads data for a page; `reload` refetches and `setData` applies a mutation's response. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    load().then(
      (value) => live && setData(value),
      (err: unknown) => live && setError(errorText(err)),
    );
    return () => {
      live = false;
    };
  }, [...deps, version]);
  return { data, setData, error, reload: () => setVersion((v) => v + 1) };
}

/** Calls `reload` every 5 seconds while `active`; refreshes keep the data already shown. */
export function usePoll(active: boolean, reload: () => void) {
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(reload, 5000);
    return () => clearInterval(timer);
  }, [active]);
}

/** Runs one action at a time and keeps its error beside the control that started it. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(work: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await work();
    } catch (err) {
      setError(errorText(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

export function Page({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1>{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-slate-600">{subtitle}</p>}
        </div>
        {actions}
      </header>
      <div className="space-y-6">{children}</div>
    </div>
  );
}

export function Panel({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs sm:p-5">
      {title && <h2 className="mb-3">{title}</h2>}
      {children}
    </section>
  );
}

export function ErrorNote({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-sm text-red-700">
      {error}
    </p>
  );
}

export function Loading({ error }: { error: string | null }) {
  return error ? (
    <ErrorNote error={error} />
  ) : (
    <p className="text-sm text-slate-500" aria-live="polite">
      Loading…
    </p>
  );
}

export function StageChip({ stage, other }: { stage: RelationshipStage; other: string }) {
  return (
    <Badge variant="secondary" className={`shrink-0 ${STAGES[stage].chip}`}>
      {stageLabel(stage, other)}
    </Badge>
  );
}

export function ProvisionalChip() {
  return (
    <Badge variant="outline" className="border-amber-300 text-amber-800">
      Provisional
    </Badge>
  );
}

/** Scores come only from the server; a missing score names its reason instead of showing 0%. */
export function ScoreSummary({ score, compact }: { score: Score; compact?: boolean }) {
  if (score.state !== 'scored') {
    return <span className="text-sm text-slate-500">{SCORE_LABELS[score.state]}</span>;
  }
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span>
        <span className="text-base font-semibold tabular-nums text-slate-900">
          {percent(score.compatibility!)}
        </span>{' '}
        <span className="text-slate-500">compatibility</span>
      </span>
      {!compact && (
        <span className="text-slate-500">
          <span className="tabular-nums">{percent(score.evidenceCoverage!)}</span> evidence coverage
        </span>
      )}
      {score.provisional && <ProvisionalChip />}
    </span>
  );
}

export const fieldClass =
  'h-9 w-full rounded-md border border-input bg-white px-3 text-sm shadow-xs outline-none ' +
  'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50';

/** The other party's name, as the viewing side sees it. */
export const otherName = (m: Pick<MatchSummary, 'candidate' | 'job'>, side: DemoSide) =>
  side === 'employer' ? m.candidate.name : m.job.employer.name;

export const matchPath = (m: Pick<MatchSummary, 'candidate' | 'job'>) =>
  `/matches/${encodeURIComponent(m.candidate.key)}/${encodeURIComponent(m.job.id)}`;

/** One match in a list: who or what, the server's score state and the relationship stage. */
export function MatchRow({ m, side }: { m: MatchSummary; side: DemoSide }) {
  const title = side === 'employer' ? m.candidate.name : m.job.title;
  const detail =
    side === 'employer'
      ? [m.candidate.title, `@${m.candidate.githubLogin}`, `For: ${m.job.title}`].filter(Boolean).join(' · ')
      : [m.job.employer.name, m.job.location].filter(Boolean).join(' · ');
  return (
    <li>
      <Link
        to={matchPath(m)}
        className="flex flex-col gap-2 px-4 py-3 transition-colors duration-100 hover:bg-slate-50 active:bg-slate-100 sm:flex-row sm:items-center sm:justify-between"
      >
        <span className="min-w-0">
          <span className="block truncate font-medium text-slate-900">{title}</span>
          <span className="block truncate text-sm text-slate-500">{detail}</span>
        </span>
        <span className="flex shrink-0 flex-wrap items-center gap-3">
          <ScoreSummary score={m.score} compact />
          <StageChip stage={m.relationship.stage} other={otherName(m, side)} />
        </span>
      </Link>
    </li>
  );
}

export function MatchList({ matches, side }: { matches: MatchSummary[]; side: DemoSide }) {
  if (matches.length === 0) return <p className="text-sm text-slate-500">No matches here.</p>;
  return (
    <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">
      {matches.map((m) => (
        <MatchRow key={`${m.candidate.key}/${m.job.id}`} m={m} side={side} />
      ))}
    </ul>
  );
}

/** The posting text as retrieved, with where and when it came from and what it cannot show. */
export function PostingText({ posting }: { posting: DemoJob }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500">
        {TEXT_SOURCES[posting.textSource]}
        {posting.retrievedOn && ` · retrieved ${posting.retrievedOn}`} ·{' '}
        <a href={posting.sourceUrl} target="_blank" rel="noreferrer" className="underline underline-offset-4">
          Original posting
        </a>
      </p>
      {posting.sourceLimitations.length > 0 && (
        <ul className="list-disc pl-5 text-sm text-amber-800">
          {posting.sourceLimitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      <p className="text-sm whitespace-pre-wrap text-slate-700">{posting.text}</p>
    </div>
  );
}
