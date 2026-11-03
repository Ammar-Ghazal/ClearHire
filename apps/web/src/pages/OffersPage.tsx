// Boards 9–10: offers for the demo identity. Drafts are listed only for the employer.
import { Link, useParams } from 'react-router';
import { getOffer, getOffers } from '../api';
import { Badge } from '../components/ui/badge';
import { useChosenIdentity } from '../identity';
import { OFFER_STATUS, cad } from '../status';
import { Loading, Page, Panel, StageChip, matchPath, otherName, useLoad } from '../ui';
import { OfferPanel } from '../workflow';

export function OffersPage() {
  const { identity } = useChosenIdentity();
  const { data, error } = useLoad(getOffers, []);
  const side = identity.kind;
  return (
    <Page title="Offers">
      {!data ? (
        <Loading error={error} />
      ) : data.length === 0 ? (
        <p className="text-sm text-slate-500">
          {side === 'employer'
            ? 'No offers yet. Draft one from a match at the Interview stage.'
            : 'No offers have been shared with you yet.'}
        </p>
      ) : (
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {data.map((o) => (
            <li key={o.id}>
              <Link
                to={`/offers/${o.id}`}
                className="flex flex-col gap-2 px-4 py-3 transition-colors duration-100 hover:bg-slate-50 active:bg-slate-100 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{o.role}</span>
                  <span className="block truncate text-sm text-slate-500">
                    {otherName(o, side)} · <span className="tabular-nums">{cad(o.baseSalaryCad)}</span>
                  </span>
                </span>
                <Badge variant="secondary">{OFFER_STATUS[o.status]}</Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

export function OfferPage() {
  const { id = '' } = useParams();
  const { identity, refresh } = useChosenIdentity();
  const { data, error, reload } = useLoad(() => getOffer(id), [id]);
  if (!data) {
    return (
      <Page title="Offer">
        <Loading error={error} />
      </Page>
    );
  }
  const side = identity.kind;
  return (
    <Page
      title={data.role}
      subtitle={
        <>
          {otherName(data, side)} ·{' '}
          <Link to={matchPath(data)} className="underline underline-offset-4">
            Open match
          </Link>
        </>
      }
      actions={<StageChip stage={data.stage} other={otherName(data, side)} />}
    >
      <Panel>
        <OfferPanel
          candidateKey={data.candidate.key}
          jobId={data.job.id}
          side={side}
          stage={data.stage}
          offer={data}
          jobTitle={data.job.title}
          onChange={() => {
            reload();
            refresh();
          }}
        />
      </Panel>
    </Page>
  );
}
