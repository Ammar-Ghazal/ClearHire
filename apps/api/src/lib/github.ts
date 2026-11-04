// GitHub App user sign-in (R-3.2). Uses the web flow with the App's client id and secret.
import { z } from 'zod';

import { Octokit } from '@octokit/rest';
import { env } from '../env.js';

export const callbackUrl = () => `${env.API_PUBLIC_URL}/auth/github/callback`;

export function authorizeUrl(state: string): string {
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', env.GITHUB_CLIENT_ID ?? '');
  url.searchParams.set('redirect_uri', callbackUrl());
  url.searchParams.set('state', state);
  return url.toString();
}

export function installUrl(): string | null {
  return env.GITHUB_APP_SLUG
    ? `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`
    : null;
}

export interface UserTokens {
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
}

export class GitHubAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Exchanges the one-time code from the callback for a user access token. */
export async function exchangeCode(code: string): Promise<UserTokens> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl(),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new GitHubAuthError('token_exchange_http', `GitHub returned ${res.status}`);

  const body = (await res.json()) as Record<string, unknown>;
  if (typeof body.error === 'string') {
    throw new GitHubAuthError(body.error, String(body.error_description ?? body.error));
  }
  if (typeof body.access_token !== 'string') {
    throw new GitHubAuthError('token_missing', 'GitHub did not return an access token');
  }

  const inSeconds = (v: unknown) =>
    typeof v === 'number' ? new Date(Date.now() + v * 1000) : null;

  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    accessTokenExpiresAt: inSeconds(body.expires_in),
    refreshTokenExpiresAt: inSeconds(body.refresh_token_expires_in),
  };
}

export interface GitHubProfile {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  emails: { email: string; verified: boolean; primary: boolean }[];
  installationId: number | null;
}

/** Reads the signed-in user's profile, verified emails, and their own installation of the App. */
export async function fetchProfile(accessToken: string): Promise<GitHubProfile> {
  const octokit = new Octokit({ auth: accessToken, userAgent: 'clearhire' });

  const { data: user } = await octokit.rest.users.getAuthenticated();

  // Needs the App's "Email addresses: read" account permission; degrade gracefully without it.
  let emails: GitHubProfile['emails'] = [];
  try {
    const { data } = await octokit.rest.users.listEmailsForAuthenticatedUser({ per_page: 100 });
    emails = data.map((e) => ({ email: e.email, verified: e.verified, primary: e.primary }));
  } catch {
    emails = [];
  }

  // Installations of this App that the user can access; keep the one on their own account.
  let installationId: number | null = null;
  try {
    const { data } = await octokit.rest.apps.listInstallationsForAuthenticatedUser({ per_page: 100 });
    const own = data.installations.find(
      (i) => i.account && 'id' in i.account && i.account.id === user.id,
    );
    installationId = own?.id ?? null;
  } catch {
    installationId = null;
  }

  return {
    id: user.id,
    login: user.login,
    name: user.name ?? null,
    avatarUrl: user.avatar_url ?? null,
    emails,
    installationId,
  };
}

export async function startDeviceSignIn() {
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID ?? '', scope: 'offline_access' }),
    signal: AbortSignal.timeout(15_000),
  });
  const body: unknown = await res.json().catch(() => null);
  const error = deviceErrorSchema.safeParse(body);
  if (error.success) {
    throw new GitHubAuthError(error.data.error, 'GitHub rejected device sign-in');
  }
  if (!res.ok) throw new GitHubAuthError('device_start_failed', 'GitHub device sign-in failed');
  return deviceCodeSchema.parse(body);
}

export async function pollDeviceSignIn(deviceCode: string): Promise<UserTokens | string> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID ?? '',
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = tokenResponseSchema.parse(await res.json());
  if (body.error) return body.error;
  if (!res.ok || !body.access_token) throw new GitHubAuthError('token_missing', 'GitHub did not return a token');
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    accessTokenExpiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
    refreshTokenExpiresAt: body.refresh_token_expires_in
      ? new Date(Date.now() + body.refresh_token_expires_in * 1000)
      : null,
  };
}

const deviceErrorSchema = z.object({
  error: z.enum(['device_flow_disabled', 'incorrect_client_credentials']),
});

const deviceCodeSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  interval: z.number().positive(),
  expires_in: z.number().positive(),
});

const tokenResponseSchema = z.object({
  error: z.string().optional(),
  access_token: z.string().min(1).optional(),
  refresh_token: z.string().optional(),
  expires_in: z.number().positive().optional(),
  refresh_token_expires_in: z.number().positive().optional(),
});
