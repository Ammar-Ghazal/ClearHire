// Boards 11–12: the seeker's sample profile (read-only) with editable preferences, or the sample
// company's details. Preferences never affect scores.
import type { Arrangement, DemoCandidate, Preferences } from '@clearhire/shared';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { getDemoCandidate, getPreferences, regradeCandidate, savePreferences } from '../api';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { useChosenIdentity } from '../identity';
import { ARRANGEMENTS, REPO_FLAGS, REPO_STATES, freshnessLabel } from '../status';
import { ErrorNote, Loading, Page, Panel, useAction, useLoad, usePoll } from '../ui';

export function ProfilePage() {
  const { identity } = useChosenIdentity();
  if (identity.kind === 'candidate') return <SeekerProfile candidateKey={identity.key} />;
  return (
    <Page title={identity.name} subtitle="Sample company. Details are imported and read-only.">
      <Panel title="Company">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-slate-500">About</dt>
            <dd>{identity.description}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Location</dt>
            <dd>{identity.location ?? 'Not stated'}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-slate-500">Website</dt>
            <dd className="truncate">
              <a href={identity.url} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                {identity.url}
              </a>
            </dd>
          </div>
        </dl>
      </Panel>
      <Link to="/postings" className="text-sm font-medium underline underline-offset-4">
        View job postings
      </Link>
    </Page>
  );
}

const yesNo = (v: boolean | null) => (v === null ? 'Not checked' : v ? 'Yes' : 'No');

/** The run state first: a queued or running analysis replaces the saved result's label. */
function analysisLabel(candidate: DemoCandidate): string {
  if (candidate.run.status === 'queued') return 'Queued for analysis';
  if (candidate.run.status === 'pending') return 'Analyzing repositories';
  if (candidate.run.status === 'failed') {
    return `Last analysis failed (${candidate.run.errorCode ?? 'unknown'})`;
  }
  return freshnessLabel(candidate.freshness);
}

function SeekerProfile({ candidateKey }: { candidateKey: string }) {
  const { data, error, reload } = useLoad(() => getDemoCandidate(candidateKey), [candidateKey]);
  const regrade = useAction();
  // Repositories to regrade; all selected ones unless the seeker unticks some.
  const [skipped, setSkipped] = useState<Set<number>>(new Set());
  const running = data?.run.status === 'queued' || data?.run.status === 'pending';
  // Skill tags refresh when the run finishes.
  usePoll(running, reload);
  if (!data) {
    return (
      <Page title="Profile">
        <Loading error={error} />
      </Page>
    );
  }
  const regradable = data.repositories.flatMap((r) => (r.repoId === null ? [] : [r.repoId]));
  const toRegrade = regradable.filter((id) => !skipped.has(id));
  const toggle = (id: number) =>
    setSkipped((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <Page
      title={data.name}
      subtitle={
        <a href={data.githubUrl} target="_blank" rel="noreferrer" className="underline underline-offset-4">
          @{data.githubLogin}
        </a>
      }
    >
      <Panel title="Job preferences">
        <PreferencesForm />
      </Panel>
      <Panel title="Demonstrated skills">
        <Skills candidate={data} />
      </Panel>
      <Panel title="Selected repositories">
        <ul className="divide-y divide-slate-200">
          {data.repositories.map((r) => (
            <li key={r.repo} className="py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="flex items-baseline gap-2">
                  {r.repoId !== null && (
                    <input
                      type="checkbox"
                      aria-label={`Regrade ${r.repo}`}
                      checked={!skipped.has(r.repoId)}
                      onChange={() => toggle(r.repoId!)}
                    />
                  )}
                  <a href={r.url} target="_blank" rel="noreferrer" className="font-medium underline-offset-4 hover:underline">
                    {r.repo}
                  </a>
                </span>
                <span className="text-sm text-slate-500">{REPO_STATES[r.state]}</span>
              </div>
              {r.skills.length > 0 && (
                <p className="mt-1 text-sm text-slate-600">
                  Supports: {r.skills.map((s) => s.name).join(', ')}
                </p>
              )}
              {r.flags.length > 0 && (
                <p className="mt-1 text-sm text-amber-700">
                  {r.flags.map((flag, index) => (
                    <span key={flag}>
                      {index > 0 && ' · '}
                      <span className={flag === 'attribution_limited' ? 'font-semibold text-red-700' : undefined}>
                        {REPO_FLAGS[flag]}
                      </span>
                    </span>
                  ))}
                </p>
              )}
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title="Résumé and GitHub">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-slate-500">Résumé</dt>
            <dd>
              {data.resume.status === 'none'
                ? 'No résumé'
                : data.resume.kind === 'reconstructed_demo_resume'
                  ? 'Reconstructed demo résumé'
                  : 'Original public résumé'}
              {data.resume.pages ? ` · ${data.resume.pages} page(s)` : ''}
              {data.resume.status === 'needs_review' && ' · Needs review'}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">GitHub identity matches the résumé</dt>
            <dd>{yesNo(data.verification.identityMatchVerified)}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Public repositories verified</dt>
            <dd>{yesNo(data.verification.publicRepositoriesVerified)}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Analysis</dt>
            <dd>
              {analysisLabel(data)}
              {!running &&
                data.freshness.completedAt &&
                ` · ${new Date(data.freshness.completedAt).toLocaleDateString()}`}
            </dd>
            {regradable.length > 0 && !data.organization && (
              <dd className="mt-2 space-y-1">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={running || regrade.busy || toRegrade.length === 0}
                  onClick={async () => {
                    if (await regrade.run(() => regradeCandidate(candidateKey, toRegrade))) reload();
                  }}
                >
                  Regrade from latest code ({toRegrade.length} of {regradable.length})
                </Button>
                <ErrorNote error={regrade.error} />
              </dd>
            )}
          </div>
        </dl>
      </Panel>
    </Page>
  );
}

/** Levels are candidate-wide, so each skill appears once with its assessed level. */
function Skills({ candidate }: { candidate: DemoCandidate }) {
  const skills = new Map<string, { name: string; level: number; confidence: string }>();
  for (const repo of candidate.repositories) {
    for (const s of repo.skills) skills.set(s.skillId, s);
  }
  if (skills.size === 0) {
    return (
      <p className="text-sm text-slate-500">
        {candidate.freshness.state === 'current'
          ? 'No skills were demonstrated in attributed code.'
          : candidate.freshness.state === 'outdated'
            ? 'No demonstrated skills to display.'
            : freshnessLabel(candidate.freshness)}
      </p>
    );
  }
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {[...skills.values()]
        .sort((a, b) => b.level - a.level || a.name.localeCompare(b.name))
        .map((s) => (
          <li key={s.name} className="flex items-baseline justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
            <span>{s.name}</span>
            <span className="shrink-0 text-slate-500">
              Level {s.level} · {s.confidence}
            </span>
          </li>
        ))}
    </ul>
  );
}

const list = (value: string) =>
  value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

function PreferencesForm() {
  const { data, error } = useLoad(getPreferences, []);
  if (!data) return <Loading error={error} />;
  return <PreferencesFields initial={data} />;
}

function PreferencesFields({ initial }: { initial: Preferences }) {
  const [titles, setTitles] = useState(initial.titles.join(', '));
  const [locations, setLocations] = useState(initial.locations.join(', '));
  const [arrangements, setArrangements] = useState<Arrangement[]>(initial.arrangements);
  const [saved, setSaved] = useState(false);
  const save = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    const done = await save.run(() =>
      savePreferences({ titles: list(titles), locations: list(locations), arrangements }),
    );
    if (done) setSaved(true);
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-sm text-slate-600">These help employers understand you. They do not affect scores.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block text-slate-600">Desired titles (comma-separated)</span>
          <Input value={titles} onChange={(e) => setTitles(e.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-slate-600">Locations (comma-separated)</span>
          <Input value={locations} onChange={(e) => setLocations(e.target.value)} />
        </label>
      </div>
      <fieldset className="flex flex-wrap gap-4 text-sm">
        <legend className="mb-1 text-slate-600">Work arrangement</legend>
        {(Object.keys(ARRANGEMENTS) as Arrangement[]).map((a) => (
          <label key={a} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={arrangements.includes(a)}
              onChange={(e) =>
                setArrangements(
                  e.target.checked ? [...arrangements, a] : arrangements.filter((x) => x !== a),
                )
              }
            />
            {ARRANGEMENTS[a]}
          </label>
        ))}
      </fieldset>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={save.busy}>
          Save preferences
        </Button>
        {saved && <span className="text-sm text-emerald-700" role="status">Saved</span>}
      </div>
      <ErrorNote error={save.error} />
    </form>
  );
}
