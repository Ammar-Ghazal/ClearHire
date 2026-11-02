import type { Health, Me } from '@clearhire/shared';
import { useEffect, useState } from 'react';
import { getHealth, getMe, loginUrl, logout } from './api';
import { DemoScreen } from './DemoScreen';

const AUTH_ERRORS: Record<string, string> = {
  access_denied: 'You cancelled the GitHub sign-in.',
  state_mismatch: 'Sign-in expired or was tampered with. Please try again.',
  bad_verification_code: 'GitHub rejected the sign-in code. Please try again.',
  redirect_uri_mismatch: 'The GitHub App callback URL does not match API_PUBLIC_URL.',
  incorrect_client_credentials: 'GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET is wrong.',
};

export function App() {
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
        <header className="mb-8">
          <h1 className="text-3xl font-semibold tracking-tight">ClearHire</h1>
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
            <SignedOut githubConfigured={health?.githubConfigured ?? false} />
          ) : (
            <SignedIn me={me} onLogout={handleLogout} />
          )}
        </section>

        <h2 className="mb-3 mt-10 text-xl font-semibold tracking-tight">Demo pipeline</h2>
        <DemoScreen isOperator={me?.isDemoOperator ?? false} />
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

function SignedOut({ githubConfigured }: { githubConfigured: boolean }) {
  return (
    <div>
      <h2 className="text-lg font-medium">Sign in</h2>
      <p className="mt-1 text-sm text-slate-600">
        Connect your GitHub account to get started. ClearHire only reads the repositories you choose.
      </p>
      <a
        href={loginUrl}
        className={`mt-4 inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium text-white ${
          githubConfigured ? 'bg-slate-900 hover:bg-slate-700' : 'pointer-events-none bg-slate-400'
        }`}
        aria-disabled={!githubConfigured}
      >
        Sign in with GitHub
      </a>
      {!githubConfigured && (
        <p className="mt-2 text-xs text-amber-700">
          GitHub sign-in is not configured on the API yet (see SETUP.md).
        </p>
      )}
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
        <div>
          <dt className="font-medium text-slate-700">Repository access</dt>
          <dd className="text-slate-600">
            {me.github.installationId ? (
              <>Installed (installation {me.github.installationId}).</>
            ) : me.github.installUrl ? (
              <a className="text-blue-700 underline" href={me.github.installUrl}>
                Install the ClearHire GitHub App and choose repositories
              </a>
            ) : (
              'Not installed (set GITHUB_APP_SLUG to show the install link).'
            )}
          </dd>
        </div>
      </dl>
    </div>
  );
}
