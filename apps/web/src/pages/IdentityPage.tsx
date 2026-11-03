// Board 0: choose a demo identity. A sample candidate or employer to act as, never a sign-in.
import type { DemoJobSummary, DemoSide } from '@clearhire/shared';
import { Link, useNavigate } from 'react-router';
import { chooseDemoIdentity, getDemoCandidates, getDemoJobs } from '../api';
import { useIdentity } from '../identity';
import { ErrorNote, Loading, useAction, useLoad } from '../ui';

interface Choice {
  kind: DemoSide;
  key: string;
  name: string;
  detail: string;
}

function employersOf(jobs: DemoJobSummary[]): Choice[] {
  const byId = new Map<string, Choice & { count: number }>();
  for (const job of jobs.filter((j) => j.inScope)) {
    const e = job.employer;
    const entry = byId.get(e.id) ?? { kind: 'employer', key: e.id, name: e.name, detail: '', count: 0 };
    entry.count++;
    entry.detail = [e.location, `${entry.count} posting${entry.count === 1 ? '' : 's'}`]
      .filter(Boolean)
      .join(' · ');
    byId.set(e.id, entry);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function IdentityPage() {
  const navigate = useNavigate();
  const { identity, setIdentity } = useIdentity();
  const { data, error } = useLoad(
    () => Promise.all([getDemoCandidates(), getDemoJobs()]),
    [],
  );
  const choose = useAction();

  async function pick(choice: Choice) {
    const chosen = await choose.run(() => chooseDemoIdentity(choice.kind, choice.key));
    if (!chosen) return;
    setIdentity(chosen);
    navigate('/matches');
  }

  const current = identity?.identity;
  const candidates: Choice[] =
    data?.[0]
      .filter((c) => !c.organization)
      .map((c) => ({ kind: 'candidate', key: c.key, name: c.name, detail: `@${c.githubLogin}` })) ??
    [];

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
        <header className="max-w-2xl">
          <p className="text-sm font-medium text-slate-500">ClearHire demo</p>
          <h1 className="mt-1 text-3xl leading-tight font-semibold tracking-[-0.02em] sm:text-4xl">
            Choose a demo identity
          </h1>
          <p className="mt-3 text-slate-600">
            Act as a sample job seeker or employer to try matching, Discussion, interviews and
            offers. A demo identity is not a sign-in and is not linked to any GitHub account you
            own.
          </p>
          {current && (
            <p className="mt-4 text-sm text-slate-600">
              Current demo identity: <span className="font-medium text-slate-900">{current.name}</span>
              {' · '}
              <Link to="/matches" className="font-medium text-slate-900 underline underline-offset-4">
                Continue
              </Link>
            </p>
          )}
        </header>

        <ErrorNote error={choose.error} />
        {!data ? (
          <div className="mt-8">
            <Loading error={error} />
          </div>
        ) : (
          <div className="mt-10 grid gap-8 md:grid-cols-2">
            <ChoiceList
              title="Job seekers"
              choices={candidates}
              current={current && `${current.kind}:${current.key}`}
              busy={choose.busy}
              onPick={pick}
            />
            <ChoiceList
              title="Employers"
              choices={employersOf(data[1])}
              current={current && `${current.kind}:${current.key}`}
              busy={choose.busy}
              onPick={pick}
            />
          </div>
        )}

        <p className="mt-12 text-sm text-slate-500">
          Running the demo?{' '}
          <Link to="/operator" className="underline underline-offset-4 hover:text-slate-900">
            Operator tools
          </Link>{' '}
          (GitHub sign-in and analyses).
        </p>
      </div>
    </main>
  );
}

function ChoiceList({
  title,
  choices,
  current,
  busy,
  onPick,
}: {
  title: string;
  choices: Choice[];
  current: string | undefined;
  busy: boolean;
  onPick: (choice: Choice) => void;
}) {
  return (
    <section>
      <h2 className="mb-3">{title}</h2>
      <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">
        {choices.map((c) => (
          <li key={c.key}>
            <button
              type="button"
              disabled={busy}
              onClick={() => onPick(c)}
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors duration-100 hover:bg-slate-50 active:bg-slate-100 disabled:opacity-60"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium text-slate-900">{c.name}</span>
                <span className="block truncate text-sm text-slate-500">{c.detail}</span>
              </span>
              {`${c.kind}:${c.key}` === current && (
                <span className="shrink-0 text-xs font-medium text-slate-500">Current</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
