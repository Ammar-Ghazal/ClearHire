// Boards 6–7: the employer's imported postings and one posting's requirements, with the priority
// editor. Every change is saved on the server, then the posting and its matches are refetched.
import type { DemoJob } from '@clearhire/shared';
import { Link, Navigate, useParams } from 'react-router';
import { getDemoJob, getDemoJobs, getMatches, resetJobPriorities, setJobPriority } from '../api';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { useChosenIdentity } from '../identity';
import { freshnessLabel } from '../status';
import {
  ErrorNote,
  Loading,
  MatchList,
  Page,
  Panel,
  PostingText,
  useAction,
  useLoad,
  usePoll,
} from '../ui';

export function PostingsPage() {
  const { identity } = useChosenIdentity();
  const { data, error } = useLoad(getDemoJobs, []);
  if (identity.kind !== 'employer') return <Navigate to="/matches" replace />;
  const mine = data?.filter((j) => j.employer.id === identity.key);
  return (
    <Page title="Job postings" subtitle="Imported postings. Their text is not edited here.">
      {!mine ? (
        <Loading error={error} />
      ) : (
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {mine.map((j) => (
            <li key={j.id}>
              <Link
                to={`/postings/${encodeURIComponent(j.id)}`}
                className="flex items-center justify-between gap-3 px-4 py-3 transition-colors duration-[260ms] ease-out hover:bg-slate-50 hover:duration-[180ms] active:bg-slate-100 active:duration-75"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{j.title}</span>
                  <span className="block truncate text-sm text-slate-500">
                    {j.location ?? 'Location not stated'}
                  </span>
                </span>
                {!j.inScope && <Badge variant="secondary">Out of scope</Badge>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

export function PostingPage() {
  const { id = '' } = useParams();
  const { identity } = useChosenIdentity();
  const job = useLoad(() => getDemoJob(id), [id]);
  const matches = useLoad(() => getMatches(id), [id]);
  const act = useAction();
  usePoll(true, () => {
    job.reload();
    matches.reload();
  });

  if (identity.kind !== 'employer') return <Navigate to="/matches" replace />;
  if (!job.data) {
    return (
      <Page title="Job posting">
        <Loading error={job.error} />
      </Page>
    );
  }
  const posting = job.data;
  if (posting.employer.id !== identity.key) return <Navigate to="/postings" replace />;
  const editable = posting.freshness.state === 'current';

  async function apply(change: () => Promise<DemoJob>) {
    const updated = await act.run(change);
    if (!updated) return;
    job.setData(updated);
    matches.reload();
  }

  return (
    <Page
      title={posting.title}
      subtitle={[posting.employer.name, posting.location].filter(Boolean).join(' · ')}
      actions={
        <a
          href={posting.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="text-sm underline underline-offset-4"
        >
          Original posting
        </a>
      }
    >
      <Panel
        title={
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span>Requirements and priorities</span>
            {editable && posting.requirements.some((r) => r.prioritySource === 'override') && (
              <Button
                variant="outline"
                size="sm"
                disabled={act.busy}
                onClick={() => apply(() => resetJobPriorities(posting.id))}
              >
                Reset all priorities
              </Button>
            )}
          </span>
        }
      >
        {!editable ? (
          <p className="text-sm text-slate-500">
            {freshnessLabel(posting.freshness)}. Priorities can change once
            this posting has a current analysis.
          </p>
        ) : (
          <>
            <p className="mb-3 text-sm text-slate-600">
              0 ignores a requirement; 3 weighs it most. Changes apply to every match for this
              posting.
            </p>
            <ul className="divide-y divide-slate-200">
              {posting.requirements.map((r) => (
                <li key={r.skillId} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <span className="min-w-0">
                    <span className="block font-medium">{r.name}</span>
                    <span className="block text-sm text-slate-500">
                      Requires level {r.requiredLevel} · Suggested priority {r.suggestedPriority}
                      {r.referenceStatus === 'needs_review' && ' · Reference needs review'}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span
                      role="radiogroup"
                      aria-label={`Priority for ${r.name}`}
                      className="inline-flex rounded-lg bg-slate-100 p-0.5"
                    >
                      {[0, 1, 2, 3].map((p) => (
                        <button
                          key={p}
                          role="radio"
                          aria-checked={r.priority === p}
                          disabled={act.busy}
                          onClick={() =>
                            r.priority !== p && apply(() => setJobPriority(posting.id, r.skillId, p))
                          }
                          className="h-8 w-9 rounded-md text-sm tabular-nums text-slate-600 transition-colors duration-100 active:scale-[0.97] aria-checked:bg-white aria-checked:font-semibold aria-checked:text-slate-900 aria-checked:shadow-xs"
                        >
                          {p}
                        </button>
                      ))}
                    </span>
                    {r.prioritySource === 'override' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={act.busy}
                        onClick={() => apply(() => setJobPriority(posting.id, r.skillId, null))}
                      >
                        Reset
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        <ErrorNote error={act.error} />
      </Panel>

      <Panel title="Matches for this posting">
        {matches.data ? (
          <MatchList matches={matches.data} side="employer" />
        ) : (
          <Loading error={matches.error} />
        )}
      </Panel>

      <Panel>
        <PostingText posting={posting} />
      </Panel>
    </Page>
  );
}
