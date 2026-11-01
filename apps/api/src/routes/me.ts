import type { Me } from '@clearhire/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client.js';
import { githubConnections, userEmails, users } from '../db/schema.js';
import { installUrl } from '../lib/github.js';
import { currentUserId } from '../lib/sessions.js';

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
    };
    return body;
  });
}
