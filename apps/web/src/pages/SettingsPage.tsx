// Board 13: the demo identity and the GitHub account of its sample profile. GitHub sign-in for
// demo operators lives on the operator page and is unaffected by the demo identity.
import { Link, useNavigate } from 'react-router';
import { clearDemoIdentity } from '../api';
import { Button } from '../components/ui/button';
import { useIdentity } from '../identity';
import { ErrorNote, Page, Panel, useAction } from '../ui';

export function SettingsPage() {
  const navigate = useNavigate();
  const { identity, setIdentity } = useIdentity();
  const clear = useAction();
  if (!identity) return null;
  const who = identity.identity;

  async function leave() {
    const cleared = await clear.run(async () => {
      await clearDemoIdentity();
      return true;
    });
    if (cleared) {
      setIdentity(null);
      navigate('/');
    }
  }

  return (
    <Page title="Settings">
      <Panel title="Demo identity">
        <p className="text-sm text-slate-600">
          You are acting as{' '}
          <span className="font-medium text-slate-900">
            {who.name} ({who.kind === 'candidate' ? 'job seeker' : 'employer'})
          </span>
          . A demo identity is a sample profile, not a sign-in.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button asChild>
            <Link to="/">Switch demo identity</Link>
          </Button>
          <Button variant="outline" disabled={clear.busy} onClick={leave}>
            Stop using a demo identity
          </Button>
        </div>
        <ErrorNote error={clear.error} />
      </Panel>
      <Panel title="GitHub account of the sample profile">
        {who.kind === 'candidate' ? (
          <p className="text-sm">
            <a href={who.githubUrl} target="_blank" rel="noreferrer" className="underline underline-offset-4">
              @{who.githubLogin}
            </a>
            <span className="text-slate-500"> · public account the sample profile was built from</span>
          </p>
        ) : (
          <p className="text-sm text-slate-500">Sample employers have no GitHub account.</p>
        )}
        <p className="mt-3 text-sm text-slate-500">
          Demo operators sign in with GitHub on the{' '}
          <Link to="/operator" className="underline underline-offset-4">
            operator page
          </Link>{' '}
          to start analyses.
        </p>
      </Panel>
    </Page>
  );
}
