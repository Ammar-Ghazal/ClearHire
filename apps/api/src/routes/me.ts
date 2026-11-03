import {
  RepositorySelectionBodySchema,
  type Me,
  type PublicRepository,
  type RepositorySelectionSaved,
} from '@clearhire/shared';
import { Octokit } from '@octokit/rest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db/client.js';
import { githubConnections, userEmails, users } from '../db/schema.js';
import { env, isDemoOperator } from '../env.js';
import { activeSelection } from '../lib/assessments.js';
import { decrypt } from '../lib/crypto.js';
import { installUrl } from '../lib/github.js';
import { listPublicRepos, saveSelection, type PublicRepo } from '../lib/repository-selection.js';
import { currentUserId } from '../lib/sessions.js';

const send = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).send({ error: { code, message } });

/** The signed-in user and an Octokit with their own token; null after replying with the reason. */
async function signedInGitHub(request: FastifyRequest, reply: FastifyReply) {
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
    send(reply, 409, 'github_reconnect', 'Sign in with GitHub again to list repositories');
    return null;
  }
  const auth = decrypt(connection.accessTokenEnc, env.TOKEN_ENCRYPTION_KEY);
  return { user, octokit: new Octokit({ auth }) };
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
   * browsing; nothing is added. Grading live accounts is not available yet, so nothing starts.
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
      return saved;
    },
  );
}
