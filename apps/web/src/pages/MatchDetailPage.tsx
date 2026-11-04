// Board 4: one match. Current stage and each party's answer, decisions, Discussion, interview,
// offer, the server's requirement-by-requirement evidence and the posting. No dated history.
import {
  SKILL_CATALOGUE,
  evidenceUrl,
  type Answer,
  type DemoSide,
  type EvidenceRef,
  type MatchDetail,
} from '@clearhire/shared';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  answerMatch,
  confirmInterviewStage,
  getDemoJob,
  getMatchDetail,
  getMessages,
  postMessage,
} from '../api';
import { Button } from '../components/ui/button';
import { Textarea } from '../components/ui/textarea';
import { useChosenIdentity } from '../identity';
import { ANSWERS, MESSAGE_STAGES, OPEN_STAGES, SCORE_LABELS, dateTime } from '../status';
import {
  ErrorNote,
  Loading,
  Page,
  Panel,
  PostingText,
  ScoreSummary,
  StageChip,
  otherName,
  useAction,
  useLoad,
  usePoll,
} from '../ui';
import { InterviewPanel, OfferPanel } from '../workflow';

const SKILL_NAMES = new Map<string, string>(SKILL_CATALOGUE.skills.map((s) => [s.id, s.name]));

export function MatchDetailPage() {
  const { candidate = '', job = '' } = useParams();
  const { identity, refresh } = useChosenIdentity();
  const { data, error, reload } = useLoad(() => getMatchDetail(candidate, job), [candidate, job]);
  usePoll(true, reload);
  if (!data) {
    return (
      <Page title="Match">
        <Loading error={error} />
      </Page>
    );
  }
  const side = identity.kind;
  const other = otherName(data, side);
  const stage = data.relationship.stage;
  const onChange = () => {
    reload();
    refresh();
  };
  const ref = { candidateKey: candidate, jobId: job, side, stage, onChange };
  const atInterview = ['interview', 'offer_shared', 'offer_accepted', 'offer_declined'].includes(
    stage,
  );

  return (
    <Page
      title={side === 'employer' ? data.candidate.name : data.job.title}
      subtitle={
        side === 'employer'
          ? [data.candidate.title, `@${data.candidate.githubLogin}`, `For: ${data.job.title}`]
              .filter(Boolean)
              .join(' · ')
          : [data.job.employer.name, data.job.location].filter(Boolean).join(' · ')
      }
      actions={<StageChip stage={stage} other={other} />}
    >
      <Panel>
        <ScoreSummary score={data.score} />
      </Panel>

      <Panel title="Decision">
        <Decision detail={data} side={side} other={other} onChange={onChange} />
      </Panel>

      {(atInterview || data.interview) && (
        <Panel title="Interview">
          <InterviewPanel {...ref} interview={data.interview} />
        </Panel>
      )}

      {(atInterview || data.offer) && (side === 'employer' || data.offer) && (
        <Panel title="Offer">
          <OfferPanel {...ref} offer={data.offer} jobTitle={data.job.title} />
        </Panel>
      )}

      {stage !== 'needs_response' && stage !== 'waiting' && (
        <Panel title="Discussion">
          <Discussion candidate={candidate} job={job} side={side} other={other} open={MESSAGE_STAGES.includes(stage)} />
        </Panel>
      )}

      <Panel title="Requirements and evidence">
        <Requirements detail={data} side={side} />
      </Panel>

      <Panel title="Posting">
        <Posting id={job} />
      </Panel>
    </Page>
  );
}

function Decision({
  detail,
  side,
  other,
  onChange,
}: {
  detail: MatchDetail;
  side: DemoSide;
  other: string;
  onChange: () => void;
}) {
  const act = useAction();
  const r = detail.relationship;
  const mine = side === 'candidate' ? r.candidateAnswer : r.employerAnswer;
  const theirs = side === 'candidate' ? r.employerAnswer : r.candidateAnswer;
  const open = OPEN_STAGES.includes(r.stage);
  const choices: Answer[] = !open ? [] : mine === null ? ['yes', 'maybe', 'no'] : mine !== 'no' ? ['no'] : [];

  async function answer(value: Answer) {
    if (
      value === 'no' &&
      !window.confirm('No is permanent: the match closes and Discussion becomes read-only.')
    ) {
      return;
    }
    if (await act.run(() => answerMatch(detail.candidate.key, detail.job.id, value))) onChange();
  }
  async function confirm() {
    if (await act.run(() => confirmInterviewStage(detail.candidate.key, detail.job.id))) onChange();
  }

  const myConfirmed = side === 'candidate' ? r.candidateConfirmed : r.employerConfirmed;
  const theirConfirmed = side === 'candidate' ? r.employerConfirmed : r.candidateConfirmed;
  return (
    <div className="space-y-4">
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-slate-500">Your answer</dt>
          <dd className="font-medium">{mine ? ANSWERS[mine] : 'Not answered yet'}</dd>
        </div>
        <div>
          <dt className="text-slate-500">{other}’s answer</dt>
          <dd className="font-medium">{theirs ? ANSWERS[theirs] : 'Not answered yet'}</dd>
        </div>
      </dl>
      {mine === null && open && (
        <p className="text-sm text-slate-600">
          Nothing opens until you both answer. Two Yes answers go straight to an interview; a Maybe
          opens Discussion first.
        </p>
      )}
      {choices.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {choices.map((c) => (
            <Button
              key={c}
              variant={c === 'yes' ? 'default' : 'outline'}
              disabled={act.busy}
              onClick={() => answer(c)}
            >
              {mine === null ? ANSWERS[c] : 'Change to No'}
            </Button>
          ))}
        </div>
      )}
      {r.stage === 'discussion' && (
        <div className="space-y-2 border-t border-slate-200 pt-4">
          <p className="text-sm text-slate-600">
            Move to an interview when you both confirm.{' '}
            {theirConfirmed ? `${other} has confirmed.` : `${other} has not confirmed yet.`}
          </p>
          {myConfirmed ? (
            <p className="text-sm font-medium">You confirmed.</p>
          ) : (
            <Button disabled={act.busy} onClick={confirm}>
              Confirm interview
            </Button>
          )}
        </div>
      )}
      <ErrorNote error={act.error} />
    </div>
  );
}

/** Both sides read the same posting text and source details. */
function Posting({ id }: { id: string }) {
  const { data, error } = useLoad(() => getDemoJob(id), [id]);
  return data ? <PostingText posting={data} /> : <Loading error={error} />;
}

function Discussion({
  candidate,
  job,
  side,
  other,
  open,
}: {
  candidate: string;
  job: string;
  side: DemoSide;
  other: string;
  open: boolean;
}) {
  const { data, setData, error } = useLoad(() => getMessages(candidate, job), [candidate, job]);
  const [body, setBody] = useState('');
  const send = useAction();
  if (!data) return <Loading error={error} />;
  return (
    <div className="space-y-4">
      {data.length === 0 ? (
        <p className="text-sm text-slate-500">No messages yet.</p>
      ) : (
        <ol className="space-y-2">
          {data.map((m) => {
            const mine = m.authorSide === side;
            return (
              <li key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                    mine ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-900'
                  }`}
                >
                  <p className="whitespace-pre-wrap">{m.body}</p>
                  <p className={`mt-1 text-xs ${mine ? 'text-slate-300' : 'text-slate-500'}`}>
                    {mine ? 'You' : other} · {dateTime(m.createdAt)}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {open ? (
        <form
          className="space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const messages = await send.run(() => postMessage(candidate, job, body));
            if (messages) {
              setData(messages);
              setBody('');
            }
          }}
        >
          <Textarea
            aria-label="Message"
            required
            maxLength={2000}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={`Write to ${other}`}
          />
          <Button type="submit" disabled={send.busy || !body.trim()}>
            Send
          </Button>
          <ErrorNote error={send.error} />
        </form>
      ) : (
        <p className="text-sm text-slate-500">Discussion is read-only for this match.</p>
      )}
    </div>
  );
}

const VERDICTS = {
  met: 'Met',
  partly_met: 'Partly met',
  below_required: 'Below the required level',
  not_demonstrated: 'Not demonstrated',
} as const;

function attributionNotes(ref: EvidenceRef, login: string): string[] {
  const notes = {
    sole: [`Recorded only under @${login}`],
    shared: ['Recorded under several accounts'],
    provisional: ['PR landing not confirmed'],
    unknown: [],
  }[ref.attribution ?? 'unknown'];
  return ref.contributions.some((c) => c.aiCoauthorDeclared)
    ? [...notes, 'AI co-author declared']
    : notes;
}

function Requirements({ detail, side }: { detail: MatchDetail; side: DemoSide }) {
  const m = detail.match;
  if (m.availability === 'unavailable' || m.match.requirements.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        {detail.score.state === 'scored'
          ? 'This posting has no requirements.'
          : `${SCORE_LABELS[detail.score.state]}. Requirements appear once both analyses are current.`}
      </p>
    );
  }
  const { requirements, eligibilityConstraints } = m.match;
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Skill levels are assessed across the candidate’s selected repositories. Priorities run from
        0 (ignored) to 3.{' '}
        {side === 'employer' && (
          <Link
            className="font-medium text-slate-900 underline underline-offset-4"
            to={`/postings/${encodeURIComponent(detail.job.id)}`}
          >
            Edit priorities
          </Link>
        )}
      </p>
      <ul className="divide-y divide-slate-200">
        {requirements.map((r) => (
          <li key={r.skillId} className="py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">{SKILL_NAMES.get(r.skillId) ?? r.skillId}</span>
              <span className="text-sm text-slate-600">{VERDICTS[r.verdict]}</span>
            </div>
            <p className="mt-0.5 text-sm text-slate-500">
              Requires level {r.requiredLevel} · Priority {r.priority}
              {r.prioritySource === 'suggested' ? ' (suggested)' : ''}
              {r.candidateLevel !== null && ` · Demonstrated level ${r.candidateLevel}`}
              {r.confidence && ` · ${r.confidence} confidence`}
              {r.referenceStatus === 'needs_review' && ' · Posting reference needs review'}
            </p>
            {r.evidence.length > 0 && (
              <ul className="mt-2 space-y-1">
                {r.evidence.map((e) => (
                  <li key={e.ref} className="text-sm">
                    <a
                      href={evidenceUrl(e)}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-xs break-all text-slate-700 underline underline-offset-4"
                    >
                      {e.repo}/{e.path}#L{e.startLine}-L{e.endLine}
                    </a>
                    {attributionNotes(e, detail.candidate.githubLogin).map((n) => (
                      <span key={n} className="ml-2 text-xs text-slate-500">
                        {n}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {eligibilityConstraints.length > 0 && (
        <div>
          <h3 className="text-sm font-medium">Eligibility stated in the posting</h3>
          <ul className="mt-1 list-disc pl-5 text-sm text-slate-600">
            {eligibilityConstraints.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
