// Boards 2–3 and 5: every match for the demo identity, filtered by stage group and, for employers,
// by posting. Sorting happens here; scores always come from the server.
import type { MatchSummary } from '@clearhire/shared';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { getDemoJobs, getMatches } from '../api';
import { useChosenIdentity } from '../identity';
import { STAGE_FILTERS, STAGES, type StageGroup } from '../status';
import { fieldClass, Loading, MatchList, Page, useLoad } from '../ui';

const SORTS = {
  compatibility: 'Compatibility',
  coverage: 'Evidence coverage',
  activity: 'Recent activity',
} as const;
type Sort = keyof typeof SORTS;

// Unscored pairs sort after scored ones, whatever their reason.
const by: Record<Sort, (m: MatchSummary) => number> = {
  compatibility: (m) => m.score.compatibility ?? -1,
  coverage: (m) => m.score.evidenceCoverage ?? -1,
  activity: (m) => (m.lastActivityAt ? Date.parse(m.lastActivityAt) : 0),
};

export function MatchesPage() {
  const { identity } = useChosenIdentity();
  const [params, setParams] = useSearchParams();
  const job = params.get('job') ?? undefined;
  const [filter, setFilter] = useState<StageGroup | 'all'>('all');
  const [sort, setSort] = useState<Sort>('compatibility');
  const { data, error } = useLoad(() => getMatches(job), [job]);
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
  const shown = (data ?? [])
    .filter((m) => filter === 'all' || STAGES[m.relationship.stage].group === filter)
    .sort((a, b) => by[sort](b) - by[sort](a));

  return (
    <Page
      title="Matches"
      subtitle={
        identity.kind === 'employer'
          ? 'Every sample job seeker for your postings, with no minimum compatibility.'
          : 'Every in-scope posting, with no minimum compatibility.'
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
          <span className="mb-1 block text-slate-600">Sort by</span>
          <select
            className={fieldClass}
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
          >
            {Object.entries(SORTS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
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

      {data ? <MatchList matches={shown} side={identity.kind} /> : <Loading error={error} />}
    </Page>
  );
}
