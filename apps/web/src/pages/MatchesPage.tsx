// Boards 2–3 and 5: the top matches for the demo identity, filtered by stage group and, for
// employers, by posting. The display limit never limits what is graded; scores come from the server.
import { topMatches, TOP_MATCHES, type MatchSummary } from '@clearhire/shared';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { getDemoJobs, getMatches } from '../api';
import { useChosenIdentity } from '../identity';
import { STAGE_FILTERS, STAGES, type StageGroup } from '../status';
import { fieldClass, Loading, MatchList, Page, useLoad, usePoll } from '../ui';

/** Why the remaining pairs in the filtered set have no score yet. */
function unscoredSummary(matches: MatchSummary[]): string | null {
  const count = (state: MatchSummary['score']['state']) =>
    matches.filter((m) => m.score.state === state).length;
  const parts = [
    [count('updating'), 'being analyzed'],
    [count('not_analyzed'), 'not analyzed yet'],
    [count('failed'), 'analysis failed'],
    [count('outdated'), 'analysis outdated'],
    [count('profile_incomplete'), 'incomplete profile'],
    [count('no_attributed_code'), 'no attributed code'],
    [count('zero_priority'), 'every priority is 0'],
  ].flatMap(([n, label]) => (n ? [`${n} ${label}`] : []));
  return parts.length > 0 ? `Not scored: ${parts.join(' · ')}.` : null;
}

export function MatchesPage() {
  const { identity } = useChosenIdentity();
  const [params, setParams] = useSearchParams();
  const job = params.get('job') ?? undefined;
  const [filter, setFilter] = useState<StageGroup | 'all'>('all');
  const [top, setTop] = useState<number>(TOP_MATCHES.default);
  const { data, error, reload } = useLoad(() => getMatches(job), [job]);
  const postings = useLoad(
    () =>
      identity.kind === 'employer'
        ? getDemoJobs().then((jobs) =>
            jobs.filter((j) => j.employer.id === identity.key && j.inScope),
          )
        : Promise.resolve([]),
    [identity.kind, identity.key],
  );

  const count = (group: StageGroup | 'all') =>
    data?.filter((m) => group === 'all' || STAGES[m.relationship.stage].group === group).length;
  const filtered = (data ?? []).filter(
    (m) => filter === 'all' || STAGES[m.relationship.stage].group === filter,
  );
  const shown = topMatches(filtered, top);
  // Scores are recomputed from saved results on every request, so polling picks up any change.
  usePoll(true, reload);

  return (
    <Page
      title="Matches"
      subtitle={
        identity.kind === 'employer'
          ? 'The most compatible sample job seekers for your postings.'
          : 'The most compatible in-scope postings.'
      }
    >
      <div className="flex flex-wrap items-end gap-3">
        {identity.kind === 'employer' && (
          <label className="min-w-0 flex-1 text-sm sm:max-w-xs">
            <span className="mb-1 block text-slate-600">Posting</span>
            <select
              className={fieldClass}
              value={job ?? ''}
              onChange={(e) => setParams(e.target.value ? { job: e.target.value } : {})}
            >
              <option value="">All postings</option>
              {postings.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">
            Show top <span className="tabular-nums font-medium text-slate-900">{top}</span>
          </span>
          <input
            type="range"
            min={TOP_MATCHES.min}
            max={TOP_MATCHES.max}
            step={1}
            value={top}
            onChange={(e) => setTop(Number(e.target.value))}
            className="h-9 w-40 accent-slate-900"
          />
        </label>
      </div>

      <div role="tablist" aria-label="Filter by stage" className="-mx-1 flex gap-1 overflow-x-auto px-1 [scrollbar-width:none]">
        {STAGE_FILTERS.map((f) => (
          <button
            key={f.value}
            role="tab"
            aria-selected={filter === f.value}
            onClick={() => setFilter(f.value)}
            className="shrink-0 rounded-full px-3 py-1.5 text-sm text-slate-600 transition-colors duration-100 hover:bg-slate-200/60 active:bg-slate-200 aria-selected:bg-slate-900 aria-selected:text-white"
          >
            {f.label}
            {data && <span className="ml-1.5 tabular-nums opacity-70">{count(f.value)}</span>}
          </button>
        ))}
      </div>

      {data ? (
        <>
          <MatchList matches={shown} side={identity.kind} />
          <p className="text-sm text-slate-500" aria-live="polite">
            {unscoredSummary(filtered)}
          </p>
        </>
      ) : (
        <Loading error={error} />
      )}
    </Page>
  );
}
