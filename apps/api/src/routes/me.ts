import {
  RepositorySelectionBodySchema,
  type Me,
  type PublicRepository,
  type RepositorySelectionSaved,
} from '@clearhire/shared';
import type { Octokit } from '@octokit/rest';
import { demoOctokit } from '../lib/demo-prepare.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db/client.js';
import { githubConnections, userEmails, users } from '../db/schema.js';
import { env, isDemoOperator } from '../env.js';
import { gradeJudge, judgeProfile } from '../lib/judge-profile.js';
import { safeErrorCode } from '../lib/demo-runner.js';
import { activeSelection } from '../lib/assessments.js';
import { decrypt } from '../lib/crypto.js';
import { installUrl } from '../lib/github.js';
import { listPublicRepos, saveSelection, type PublicRepo } from '../lib/repository-selection.js';
import { currentUserId } from '../lib/sessions.js';

const send = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).send({ error: { code, message } });

/** The signed-in user and an Octokit with their own token; null after replying with the reason. */
export async function signedInGitHub(request: FastifyRequest, reply: FastifyReply, validate = false) {
  const userId = await currentUserId(request);
  const [user] = userId ? await db.select().from(users).where(eq(users.id, userId)) : [];
  if (!user) {
    send(reply, 401, 'unauthenticated', 'Not signed in');
    return null;
  }
  const [connection] = await db
    .select()
    .from(githubConnections)
    .where(eq(githubConnections.userId, user.id));
  const expired = connection?.accessTokenExpiresAt && connection.accessTokenExpiresAt <= new Date();
  if (!connection || connection.status !== 'active' || expired) {
    send(reply, 409, 'github_reconnect', 'Sign in with GitHub again');
    return null;
  }
  const auth = decrypt(connection.accessTokenEnc, env.TOKEN_ENCRYPTION_KEY);
  const octokit = demoOctokit(auth);
  if (validate) {
    try {
      const { data } = await octokit.rest.users.getAuthenticated();
      if (data.id !== user.githubUserId) {
        send(reply, 409, 'github_reconnect', 'Sign in with GitHub again');
        return null;
      }
    } catch (err) {
      const revoked = (err as { status?: number }).status === 401;
      send(reply, revoked ? 409 : 502, revoked ? 'github_reconnect' : 'github_unavailable',
        revoked ? 'Sign in with GitHub again' : 'GitHub could not verify your connection; try again');
      return null;
    }
  }
  return { user, octokit };
}

/** Public repositories only, from listing metadata; never any code. */
async function listing(reply: FastifyReply, octokit: Octokit, login: string) {
  try {
    return await listPublicRepos(octokit, login);
  } catch {
    send(reply, 502, 'github_unavailable', 'GitHub did not list the repositories; try again');
    return null;
  }
}

const withSelected = (repos: PublicRepo[], selected: Set<number>): PublicRepository[] =>
  repos.map((r) => ({ ...r, selected: selected.has(r.id) }));

export async function meRoutes(app: FastifyInstance) {
  const grading = new Set<string>();
  const selecting = new Set<string>();
  const failures = new Map<string, string>();

  app.get('/me/profile', async (request, reply) => {
    const userId = await currentUserId(request);
    if (!userId) return send(reply, 401, 'unauthenticated', 'Sign in with GitHub');
    const profile = await judgeProfile(userId);
    return {
      ...profile, running: grading.has(userId), errorCode: failures.get(userId) ?? null,
    };
  });

  app.post('/me/profile/analysis', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const github = await signedInGitHub(request, reply, true);
      if (!github) return reply;
      if (!env.META_API_KEY) return send(reply, 409, 'model_not_configured', 'Set META_API_KEY first');
      const { user, octokit } = github;
      if (grading.has(user.id) || selecting.has(user.id)) return send(reply, 409, 'in_progress', 'Wait for the current action to finish');
      grading.add(user.id);
      let started = false;
      try {
        const selection = await activeSelection({ kind: 'user', key: user.id });
        if (selection.length === 0) return send(reply, 409, 'no_selected_repositories', 'Save at least one repository first');
        const repos = await listing(reply, octokit, user.login);
        if (!repos) return reply;
        if (selection.some((repo) => !repos.some((r) => r.id === repo.repoId && r.fullName === repo.fullName))) {
          return send(reply, 409, 'selection_changed', 'Save a new selection of repositories you still own and that are public');
        }
        const emails = await db.select().from(userEmails).where(eq(userEmails.userId, user.id));
        failures.delete(user.id);
        started = true;
        void gradeJudge(user.id, octokit, {
          githubUserId: user.githubUserId,
          login: user.login,
          verifiedEmails: emails.filter((email) => email.verified).map((email) => email.email),
        }, selection).catch((err: unknown) => {
          const code = safeErrorCode(err);
          failures.set(user.id, code);
          request.log.warn({ code }, 'Judge analysis failed');
        }).finally(() => grading.delete(user.id));
        return reply.code(202).send({ result: 'started' });
      } finally {
        if (!started) grading.delete(user.id);
      }
    });

  app.get('/me', async (request, reply) => {
    const userId = await currentUserId(request);
    if (!userId) {
      return reply.code(401).send({ error: { code: 'unauthenticated', message: 'Not signed in' } });
    }

    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) {
      return reply.code(401).send({ error: { code: 'unauthenticated', message: 'Not signed in' } });
    }
    const emails = await db
      .select({ email: userEmails.email, verified: userEmails.verified, primary: userEmails.primary })
      .from(userEmails)
      .where(eq(userEmails.userId, userId));
    const [connection] = await db
      .select({ installationId: githubConnections.installationId })
      .from(githubConnections)
      .where(eq(githubConnections.userId, userId))
      .limit(1);

    const body: Me = {
      id: user.id,
      githubLogin: user.login,
      name: user.name,
      avatarUrl: user.avatarUrl,
      emails,
      github: {
        installationId: connection?.installationId ?? null,
        installUrl: installUrl(),
      },
      isDemoOperator: isDemoOperator(user.login),
    };
    return body;
  });

  app.get(
    '/me/repositories',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const signedIn = await signedInGitHub(request, reply);
      if (!signedIn) return reply;
      const repos = await listing(reply, signedIn.octokit, signedIn.user.login);
      if (!repos) return reply;
      const selection = await activeSelection({ kind: 'user', key: signedIn.user.id });
      return withSelected(repos, new Set(selection.map((s) => s.repoId)));
    },
  );

  /**
   * Saves exactly the chosen repositories (at most 10), in the given order. Rankings only help
   * browsing; nothing is added. Grading starts only on explicit request.
   */
  app.put(
    '/me/repositories/selection',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = RepositorySelectionBodySchema.safeParse(request.body);
      if (!body.success) return send(reply, 400, 'invalid_input', 'Choose at most 10 repositories');
      const signedIn = await signedInGitHub(request, reply);
      if (!signedIn) return reply;
      const repos = await listing(reply, signedIn.octokit, signedIn.user.login);
      if (!repos) return reply;
      const id = signedIn.user.id;
      if (grading.has(id) || selecting.has(id)) return send(reply, 409, 'in_progress', 'Wait for the current action to finish');
      selecting.add(id);
      try {
        const byId = new Map(repos.map((r) => [r.id, r]));
        const chosen = body.data.repoIds.map((id) => byId.get(id));
        if (chosen.some((r) => !r)) {
          return send(reply, 400, 'invalid_input', 'Only your own public repositories can be chosen');
        }
        await saveSelection(
          { kind: 'user', key: signedIn.user.id },
          chosen as PublicRepo[],
          'user',
        );
        const saved: RepositorySelectionSaved = {
          saved: true,
          grading: 'not_started',
          repositories: withSelected(repos, new Set(body.data.repoIds)),
        };
        failures.delete(id);
        return saved;
      } finally {
        selecting.delete(id);
      }
    },
  );
}
