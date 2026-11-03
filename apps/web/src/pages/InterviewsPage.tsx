// Board 8: interviews for the demo identity, with slot proposal (employer) and selection (seeker).
import { Link } from 'react-router';
import { getInterviews } from '../api';
import { useChosenIdentity } from '../identity';
import { Loading, Page, Panel, StageChip, matchPath, otherName, useLoad } from '../ui';
import { InterviewPanel } from '../workflow';

export function InterviewsPage() {
  const { identity, refresh } = useChosenIdentity();
  const { data, error, reload } = useLoad(getInterviews, []);
  const side = identity.kind;
  return (
    <Page
      title="Interviews"
      subtitle="One interview per match. Times are proposed by the employer and confirmed by the job seeker."
    >
      {!data ? (
        <Loading error={error} />
      ) : data.length === 0 ? (
        <p className="text-sm text-slate-500">No matches have reached the Interview stage yet.</p>
      ) : (
        data.map((item) => (
          <Panel
            key={`${item.candidate.key}/${item.job.id}`}
            title={
              <span className="flex flex-wrap items-center justify-between gap-2">
                <Link to={matchPath(item)} className="hover:underline">
                  {side === 'employer'
                    ? `${item.candidate.name} · ${item.job.title}`
                    : `${item.job.title} · ${item.job.employer.name}`}
                </Link>
                <StageChip stage={item.relationship.stage} other={otherName(item, side)} />
              </span>
            }
          >
            <InterviewPanel
              candidateKey={item.candidate.key}
              jobId={item.job.id}
              side={side}
              stage={item.relationship.stage}
              interview={item.interview}
              onChange={() => {
                reload();
                refresh();
              }}
            />
          </Panel>
        ))
      )}
    </Page>
  );
}
