// Builds the Fastify app (R-2). Kept separate from server.ts so tests can create it without listening.
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { env, isProduction } from './env.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';
import { meRoutes } from './routes/me.js';

export async function buildApp() {
  const app = Fastify({
    logger: isProduction
      ? true
      : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } },
    trustProxy: true,
  });

  await app.register(cors, { origin: [env.WEB_ORIGIN], credentials: true });
  await app.register(cookie, { secret: env.SESSION_SECRET });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

  // Typed errors only; details go to the log, never to the client (R-2.9).
  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'Request failed');
    const status = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    reply.code(status).send({
      error: {
        code: status === 500 ? 'internal_error' : (error.code ?? 'bad_request'),
        message: status === 500 ? 'Something went wrong' : error.message,
      },
    });
  });
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } });
  });

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(meRoutes);

  return app;
}
