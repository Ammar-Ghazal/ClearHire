// Interview and offer panels, shared by match detail, Interviews and Offers. They only offer
// actions the current stage allows; the server enforces the same rules.
import type {
  Arrangement,
  DemoSide,
  Interview,
  Offer,
  RelationshipStage,
} from '@clearhire/shared';
import { useState, type FormEvent } from 'react';
import { confirmInterviewSlot, offerAction, saveInterview, saveOfferDraft } from './api';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Textarea } from './components/ui/textarea';
import { ARRANGEMENTS, OFFER_STATUS, cad, dateTime } from './status';
import { ErrorNote, fieldClass, useAction } from './ui';

interface MatchRef {
  candidateKey: string;
  jobId: string;
  side: DemoSide;
  stage: RelationshipStage;
  /** Reload after a successful action. */
  onChange: () => void;
}

const FORMATS: Record<Interview['format'], string> = {
  video: 'Video call',
  phone: 'Phone call',
  in_person: 'In person',
};

/** ISO instant → the local value a datetime-local input expects. */
const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-slate-600">{label}</span>
      {children}
    </label>
  );
}

export function InterviewPanel({
  interview,
  ...ref
}: MatchRef & { interview: Interview | null }) {
  const [editing, setEditing] = useState(false);
  const pick = useAction();
  const [slotId, setSlotId] = useState<string>('');
  const canEdit =
    ref.side === 'employer' && ref.stage === 'interview' && !interview?.confirmedSlotId;

  if (!interview || editing) {
    if (canEdit) {
      return (
        <InterviewForm
          {...ref}
          interview={interview}
          onCancel={interview ? () => setEditing(false) : undefined}
          onSaved={() => {
            setEditing(false);
            ref.onChange();
          }}
        />
      );
    }
    return <p className="text-sm text-slate-500">The employer has not proposed times yet.</p>;
  }

  const confirmed = interview.slots.find((s) => s.id === interview.confirmedSlotId);
  const isLink = /^https?:\/\//.test(interview.location);
  return (
    <div className="space-y-4">
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-slate-500">Format</dt>
          <dd>{FORMATS[interview.format]}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Length</dt>
          <dd>{interview.lengthMinutes} minutes</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-500">{isLink ? 'Link' : 'Location'}</dt>
          <dd className="truncate">
            {isLink ? (
              <a className="underline underline-offset-4" href={interview.location} target="_blank" rel="noreferrer">
                {interview.location}
              </a>
            ) : (
              interview.location
            )}
          </dd>
        </div>
      </dl>

      {confirmed ? (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          Confirmed for <span className="font-medium">{dateTime(confirmed.startsAt)}</span>
        </p>
      ) : ref.side === 'candidate' && ref.stage === 'interview' ? (
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await pick.run(() => confirmInterviewSlot(ref.candidateKey, ref.jobId, slotId))) {
              ref.onChange();
            }
          }}
        >
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm text-slate-600">Pick one time</legend>
            {interview.slots.map((s) => (
              <label
                key={s.id}
                className="flex cursor-pointer items-center gap-3 rounded-lg border border-slate-200 px-3 py-2 text-sm has-checked:border-slate-900 has-checked:bg-slate-50"
              >
                <input
                  type="radio"
                  name="slot"
                  value={s.id}
                  checked={slotId === s.id}
                  onChange={() => setSlotId(s.id)}
                />
                {dateTime(s.startsAt)}
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={!slotId || pick.busy}>
              Confirm this time
            </Button>
            <span className="text-sm text-slate-500">
              Need another time? Ask in Discussion.
            </span>
          </div>
          <ErrorNote error={pick.error} />
        </form>
      ) : (
        <div className="space-y-3">
          <ul className="space-y-1 text-sm">
            {interview.slots.map((s) => (
              <li key={s.id}>{dateTime(s.startsAt)}</li>
            ))}
          </ul>
          <p className="text-sm text-slate-500">
            {ref.side === 'employer'
              ? 'Waiting for the candidate to pick a time.'
              : 'No time was confirmed.'}
          </p>
          {canEdit && (
            <Button variant="outline" onClick={() => setEditing(true)}>
              Replace times
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function InterviewForm({
  candidateKey,
  jobId,
  interview,
  onSaved,
  onCancel,
}: MatchRef & { interview: Interview | null; onSaved: () => void; onCancel?: () => void }) {
  const [format, setFormat] = useState<Interview['format']>(interview?.format ?? 'video');
  const [length, setLength] = useState(String(interview?.lengthMinutes ?? 45));
  const [location, setLocation] = useState(interview?.location ?? '');
  const [slots, setSlots] = useState<string[]>(
    interview?.slots.map((s) => toLocalInput(s.startsAt)) ?? [''],
  );
  const save = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const done = await save.run(() =>
      saveInterview(candidateKey, jobId, {
        format,
        lengthMinutes: Number(length),
        location,
        slots: slots.filter(Boolean).map((s) => new Date(s).toISOString()),
      }),
    );
    if (done) onSaved();
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-sm text-slate-600">
        Propose several times. Enter the location or meeting link by hand; nothing is booked.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Format">
          <select
            className={fieldClass}
            value={format}
            onChange={(e) => setFormat(e.target.value as Interview['format'])}
          >
            {Object.entries(FORMATS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Length (minutes)">
          <Input
            type="number"
            min={15}
            max={480}
            step={15}
            required
            value={length}
            onChange={(e) => setLength(e.target.value)}
          />
        </Field>
        <Field label={format === 'in_person' ? 'Address' : 'Meeting link or number'}>
          <Input required maxLength={300} value={location} onChange={(e) => setLocation(e.target.value)} />
        </Field>
      </div>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm text-slate-600">Proposed times</legend>
        {slots.map((value, i) => (
          <div key={i} className="flex gap-2">
            <Input
              type="datetime-local"
              required
              aria-label={`Time ${i + 1}`}
              value={value}
              onChange={(e) => setSlots(slots.map((s, j) => (j === i ? e.target.value : s)))}
            />
            {slots.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setSlots(slots.filter((_, j) => j !== i))}
              >
                Remove
              </Button>
            )}
          </div>
        ))}
        {slots.length < 10 && (
          <Button type="button" variant="outline" size="sm" onClick={() => setSlots([...slots, ''])}>
            Add a time
          </Button>
        )}
      </fieldset>
      <div className="flex gap-2">
        <Button type="submit" disabled={save.busy}>
          {interview ? 'Replace times' : 'Propose times'}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      <ErrorNote error={save.error} />
    </form>
  );
}

export function OfferTerms({ offer }: { offer: Offer }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
      <div>
        <dt className="text-slate-500">Role</dt>
        <dd className="font-medium">{offer.role}</dd>
      </div>
      <div>
        <dt className="text-slate-500">Base salary</dt>
        <dd className="font-medium tabular-nums">{cad(offer.baseSalaryCad)} / year</dd>
      </div>
      <div>
        <dt className="text-slate-500">Start date</dt>
        <dd>{new Date(`${offer.startDate}T00:00`).toLocaleDateString(undefined, { dateStyle: 'long' })}</dd>
      </div>
      <div>
        <dt className="text-slate-500">Work arrangement</dt>
        <dd>{ARRANGEMENTS[offer.arrangement]}</dd>
      </div>
      {offer.note && (
        <div className="sm:col-span-2">
          <dt className="text-slate-500">Note</dt>
          <dd className="whitespace-pre-wrap">{offer.note}</dd>
        </div>
      )}
    </dl>
  );
}

export function OfferPanel({
  offer,
  jobTitle,
  ...ref
}: MatchRef & { offer: Offer | null; jobTitle: string }) {
  const act = useAction();
  const drafting = ref.side === 'employer' && ref.stage === 'interview';

  async function run(action: 'share' | 'accept' | 'decline') {
    if (await act.run(() => offerAction(offer!.id, action))) ref.onChange();
  }

  if (drafting && (!offer || offer.status === 'draft')) {
    return (
      <div className="space-y-4">
        <OfferForm {...ref} offer={offer} jobTitle={jobTitle} />
        {offer && (
          <div className="space-y-2 border-t border-slate-200 pt-4">
            <p className="text-sm text-slate-600">
              Drafts are visible only to you. Sharing sends the offer and freezes its terms.
            </p>
            <Button disabled={act.busy} onClick={() => run('share')}>
              Share offer
            </Button>
            <ErrorNote error={act.error} />
          </div>
        )}
      </div>
    );
  }
  if (!offer) return <p className="text-sm text-slate-500">No offer has been shared.</p>;
  return (
    <div className="space-y-4">
      <p className="text-sm font-medium text-slate-900">{OFFER_STATUS[offer.status]}</p>
      <OfferTerms offer={offer} />
      {ref.side === 'candidate' && offer.status === 'shared' && ref.stage === 'offer_shared' && (
        <div className="flex flex-wrap gap-2">
          <Button disabled={act.busy} onClick={() => run('accept')}>
            Accept offer
          </Button>
          <Button
            variant="outline"
            disabled={act.busy}
            onClick={() => window.confirm('Decline this offer? This closes the match.') && run('decline')}
          >
            Decline
          </Button>
        </div>
      )}
      <ErrorNote error={act.error} />
    </div>
  );
}

function OfferForm({
  candidateKey,
  jobId,
  offer,
  jobTitle,
  onChange,
}: MatchRef & { offer: Offer | null; jobTitle: string }) {
  const [role, setRole] = useState(offer?.role ?? jobTitle);
  const [salary, setSalary] = useState(offer ? String(offer.baseSalaryCad) : '');
  const [startDate, setStartDate] = useState(offer?.startDate ?? '');
  const [arrangement, setArrangement] = useState<Arrangement>(offer?.arrangement ?? 'hybrid');
  const [note, setNote] = useState(offer?.note ?? '');
  const save = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const done = await save.run(() =>
      saveOfferDraft(candidateKey, jobId, {
        role,
        baseSalaryCad: Number(salary),
        startDate,
        arrangement,
        note,
      }),
    );
    if (done) onChange();
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Role">
          <Input required maxLength={200} value={role} onChange={(e) => setRole(e.target.value)} />
        </Field>
        <Field label="Base salary (CAD per year)">
          <Input
            type="number"
            required
            min={1}
            inputMode="numeric"
            value={salary}
            onChange={(e) => setSalary(e.target.value)}
          />
        </Field>
        <Field label="Start date">
          <Input type="date" required value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </Field>
        <Field label="Work arrangement">
          <select
            className={fieldClass}
            value={arrangement}
            onChange={(e) => setArrangement(e.target.value as Arrangement)}
          >
            {Object.entries(ARRANGEMENTS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Note">
        <Textarea maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <Button type="submit" variant={offer ? 'outline' : 'default'} disabled={save.busy}>
        {offer ? 'Save draft' : 'Create draft'}
      </Button>
      <ErrorNote error={save.error} />
    </form>
  );
}
