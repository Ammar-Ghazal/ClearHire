import {
  MAX_SELECTED_REPOSITORIES,
  SKILL_CATALOGUE,
  evidenceUrl,
  type Health,
  type Me,
  type PublicRepository,
} from '@clearhire/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  ApiRequestError,
  getHealth,
  getMe,
  getMyRepositories,
  analyzeJudgeProfile,
  getJudgeProfile,
  pollGitHubSignIn,
  startGitHubSignIn,
  logout,
  saveMyRepositories,
} from '../api';
import { DemoScreen } from '../DemoScreen';
import { ErrorNote, errorText, useAction, useLoad, usePoll } from '../ui';

const AUTH_ERRORS: Record<string, string> = {
  access_denied: 'You cancelled the GitHub sign-in.',
  state_mismatch: 'Sign-in expired or was tampered with. Please try again.',
  bad_verification_code: 'GitHub rejected the sign-in code. Please try again.',
  redirect_uri_mismatch: 'The GitHub App callback URL does not match API_PUBLIC_URL.',
  incorrect_client_credentials: 'GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET is wrong.',
};

/** Operator tools: GitHub sign-in and starting analyses. Separate from demo identities. */
export function OperatorPage({ profileOnly = false }: { profileOnly?: boolean }) {
  const [health, setHealth] = useState<Health | null | undefined>(undefined);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const error = params.get('auth_error');
    if (error) setAuthError(AUTH_ERRORS[error] ?? `Sign-in failed (${error}).`);
    if (params.size > 0) window.history.replaceState(null, '', window.location.pathname);

    void getHealth().then(setHealth);
    getMe()
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  async function handleLogout() {
    await logout();
    setMe(null);
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-2xl px-4 py-12">
        <Link to="/" className="text-sm text-slate-600 hover:text-slate-900">
          ← Choose a demo identity
        </Link>
        <header className="mb-8 mt-4">
          <h1 className="text-3xl font-semibold tracking-tight">{profileOnly ? 'My profile' : 'ClearHire operator tools'}</h1>
          <p className="mt-1 text-slate-600">
            Ranks candidates by verified evidence from their code, not by polished résumés.
          </p>
        </header>

        <StatusBar health={health} />

        {authError && (
          <div className="mb-6 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {authError}
          </div>
        )}

        <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          {me === undefined ? (
            <p className="text-slate-500">Loading…</p>
          ) : me === null ? (
            <SignedOut githubConfigured={health?.githubConfigured ?? false} onSignIn={setMe} />
          ) : (
            <SignedIn me={me} onLogout={handleLogout} />
          )}
        </section>

        {!profileOnly && (
          <>
            <h2 className="mb-3 mt-10 text-xl font-semibold tracking-tight">Demo pipeline</h2>
            <DemoScreen isOperator={me?.isDemoOperator ?? false} />
          </>
        )}
      </div>
    </main>
  );
}

function StatusBar({ health }: { health: Health | null | undefined }) {
  const items: [string, boolean | undefined][] = [
    ['API', health === undefined ? undefined : health !== null],
    ['Database', health === undefined ? undefined : health?.database === 'up'],
    ['GitHub App', health === undefined ? undefined : health?.githubConfigured === true],
  ];
  return (
    <ul className="mb-6 flex flex-wrap gap-2 text-sm">
      {items.map(([label, ok]) => (
        <li
          key={label}
          className={`rounded-full px-3 py-1 ${
            ok === undefined
              ? 'bg-slate-100 text-slate-500'
              : ok
                ? 'bg-emerald-100 text-emerald-800'
                : 'bg-amber-100 text-amber-800'
          }`}
        >
          {label}: {ok === undefined ? 'checking' : ok ? 'ok' : 'not ready'}
        </li>
      ))}
    </ul>
  );
}

function SignedOut({ githubConfigured, onSignIn }: {
  githubConfigured: boolean;
  onSignIn: (me: Me | null) => void;
}) {
  const [device, setDevice] = useState<Awaited<ReturnType<typeof startGitHubSignIn>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!device) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await pollGitHubSignIn();
        if (cancelled) return;
        if (result.status === 'pending') {
          timer = setTimeout(poll, result.intervalMs);
          return;
        }
        if (result.status === 'signed_in') {
          const me = await getMe();
          if (!cancelled && me) onSignIn(me);
          else if (!cancelled) throw new Error('Missing session');
        } else {
          setError('GitHub sign-in ended. Start again for a new code.');
          setDevice(null);
        }
      } catch {
        if (!cancelled) {
          setError('Could not finish GitHub sign-in. Try again.');
          setDevice(null);
        }
      }
    }
    timer = setTimeout(poll, device.intervalMs);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [device, onSignIn]);

  async function start() {
    setStarting(true);
    setError(null);
    try {
      setDevice(await startGitHubSignIn());
    } catch {
      setError('Could not start GitHub sign-in. Check the GitHub App device flow setting.');
    } finally {
      setStarting(false);
    }
  }

  return (
    <div>
      <h2 className="text-lg font-medium">Sign in</h2>
      {device ? (
        <p className="mt-3 text-sm">
          Enter <strong className="font-mono">{device.code}</strong> on{' '}
          <a href="https://github.com/login/device" target="_blank" rel="noreferrer" className="underline">GitHub</a>.
          This page updates after you approve.
        </p>
      ) : (
        <button type="button" onClick={() => void start()} disabled={!githubConfigured || starting}
          className="mt-3 rounded-md bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50">
          Sign in with GitHub
        </button>
      )}
      {!githubConfigured && <p className="mt-2 text-sm">GitHub sign-in setup is in SETUP.md.</p>}
      {error && <p role="alert" className="mt-2 text-sm text-red-800">{error}</p>}
    </div>
  );
}

function SignedIn({ me, onLogout }: { me: Me; onLogout: () => void }) {
  return (
    <div>
      <div className="flex items-center gap-4">
        {me.avatarUrl && <img src={me.avatarUrl} alt="" className="h-14 w-14 rounded-full" />}
        <div>
          <p className="text-lg font-medium">{me.name ?? me.githubLogin}</p>
          <p className="text-sm text-slate-600">@{me.githubLogin}</p>
        </div>
        <button
          onClick={onLogout}
          className="ml-auto rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
        >
          Sign out
        </button>
      </div>

      <dl className="mt-6 space-y-3 text-sm">
        <div>
          <dt className="font-medium text-slate-700">Verified emails</dt>
          <dd className="text-slate-600">
            {me.emails.filter((e) => e.verified).map((e) => e.email).join(', ') ||
              'None visible (check the App has "Email addresses: read").'}
          </dd>
        </div>
      </dl>
      <JudgeAssessment />
    </div>
  );
}

const skillNames = new Map<string, string>(SKILL_CATALOGUE.skills.map(({ id, name }) => [id, name]));

function JudgeAssessment() {
  const { data, error, reload } = useLoad(getJudgeProfile, []);
  const analyze = useAction();
  usePoll(Boolean(data?.running), reload);
  return (
    <>
      <RepositoryChoice disabled={Boolean(data?.running)} onSaved={reload} />
      <button type="button" disabled={!data || data.running || analyze.busy}
        className="mt-4 rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        onClick={async () => { if (await analyze.run(analyzeJudgeProfile)) reload(); }}>
        {data?.running ? 'Analyzing…' : 'Analyze my repos'}
      </button>
      <ErrorNote error={analyze.error ?? error ?? (data?.errorCode ? errorText(new ApiRequestError(data.errorCode)) : null)} />
      {data?.assessment && (
        <section className="mt-6 space-y-3">
          <h2 className="font-medium">Skill markers</h2>
          {data.assessment.skills.length === 0 && <p>No attributable skill markers were found.</p>}
          <ul className="space-y-3 text-sm">
            {data.assessment.skills.map((skill) => (
              <li key={skill.skillId}>
                <strong>{skillNames.get(skill.skillId) ?? skill.skillId} · Level {skill.level}</strong>
                <p>{skill.rationale}</p>
                <ul>
                  {skill.evidence.map((ref, index) => (
                    <li key={index}><a className="underline" href={evidenceUrl(ref)} target="_blank" rel="noreferrer">
                      {ref.repo}/{ref.path} (lines {ref.startLine}–{ref.endLine})
                    </a></li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          {data.match && (
            <section className="border-t pt-3 text-sm">
              <h2 className="font-medium">Sample match · {data.jobTitle}</h2>
              {data.match.status === 'scored'
                ? <p>{Math.round(data.match.compatibility)}% match · {Math.round(data.match.evidenceCoverage)}% evidence coverage</p>
                : <p>No score for this posting.</p>}
              <ul>{data.match.requirements.map((requirement) => (
                <li key={requirement.skillId}>{skillNames.get(requirement.skillId) ?? requirement.skillId} · {requirement.verdict.replaceAll('_', ' ')}</li>
              ))}</ul>
            </section>
          )}
        </section>
      )}
    </>
  );
}

const pushed = (r: PublicRepository) => (r.pushedAt ? Date.parse(r.pushedAt) : 0);

/**
 * Public repositories to assess, at most 10, in the order chosen. Sorting only helps browsing;
 * nothing is chosen automatically. Saving and analyzing are separate actions.
 */
function RepositoryChoice({ disabled, onSaved }: { disabled: boolean; onSaved: () => void }) {
  const [repos, setRepos] = useState<PublicRepository[] | null>(null);
  const [chosen, setChosen] = useState<number[]>([]);
  const [sort, setSort] = useState<'stars' | 'pushed'>('stars');
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getMyRepositories()
      .then((list) => {
        setRepos(list);
        setChosen(list.filter((r) => r.selected).map((r) => r.id));
      })
      .catch((err: unknown) => {
        const code = err instanceof ApiRequestError ? ` (${err.code})` : '';
        setStatus(`Could not list repositories${code}.`);
      });
  }, []);

  const toggle = (id: number) =>
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  async function save() {
    setSaving(true);
    try {
      await saveMyRepositories(chosen);
      setStatus('Selection saved.');
      onSaved();
    } catch (err) {
      setStatus(err instanceof ApiRequestError ? `Not saved (${err.code}).` : 'Not saved.');
    } finally {
      setSaving(false);
    }
  }

  const sorted = [...(repos ?? [])].sort((a, b) =>
    sort === 'stars' ? b.stars - a.stars || pushed(b) - pushed(a) : pushed(b) - pushed(a),
  );
  const full = chosen.length >= MAX_SELECTED_REPOSITORIES;
  return (
    <section className="mt-8">
      <div className="flex items-center gap-3">
        <h2 className="font-medium text-slate-800">Repositories to assess</h2>
        <span className="text-sm text-slate-500">
          {chosen.length} of {MAX_SELECTED_REPOSITORIES} chosen
        </span>
        <label className="ml-auto text-sm text-slate-600">
          Sort by{' '}
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as 'stars' | 'pushed')}
            className="rounded-md border border-slate-300 px-2 py-1"
          >
            <option value="stars">Stars</option>
            <option value="pushed">Latest push</option>
          </select>
        </label>
      </div>
      {repos === null && !status && <p className="mt-3 text-sm text-slate-500">Loading…</p>}
      {repos && repos.length === 0 && (
        <p className="mt-3 text-sm text-slate-500">No public repositories found.</p>
      )}
      <ul className="mt-3 divide-y divide-slate-200 rounded-md border border-slate-200">
        {sorted.map((r) => {
          const on = chosen.includes(r.id);
          return (
            <li key={r.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <input
                type="checkbox"
                id={`repo-${r.id}`}
                checked={on}
                disabled={disabled || (!on && full)}
                onChange={() => toggle(r.id)}
              />
              <label htmlFor={`repo-${r.id}`} className="flex-1 text-slate-800">
                {r.fullName}
                {r.fork && <span className="ml-2 text-xs text-slate-500">fork</span>}
                {r.archived && <span className="ml-2 text-xs text-slate-500">archived</span>}
              </label>
              <span className="text-xs text-slate-500">★ {r.stars}</span>
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={() => void save()}
          disabled={disabled || saving || repos === null}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white hover:bg-slate-700 disabled:bg-slate-400"
        >
          Save selection
        </button>
        {status && (
          <p role="status" className="text-sm text-slate-600">
            {status}
          </p>
        )}
      </div>
    </section>
  );
}
