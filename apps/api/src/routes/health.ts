import type { Health } from '@hireproof/shared';
import type { FastifyInstance } from 'fastify';
import { databaseIsUp } from '../db/client.js';
import { githubConfigured } from '../env.js';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (_request, reply) => {
    const dbUp = await databaseIsUp();
    const body: Health = {
      status: dbUp ? 'ok' : 'degraded',
      database: dbUp ? 'up' : 'down',
      githubConfigured,
    };
    return reply.code(dbUp ? 200 : 503).send(body);
  });
}
