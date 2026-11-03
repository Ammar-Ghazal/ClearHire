// Builds the Fastify app (R-2). Kept separate from server.ts so tests can create it without listening.
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { env, isProduction } from './env.js';
import { authRoutes } from './routes/auth.js';
import { demoRoutes } from './routes/demo.js';
import { demoWorkflowRoutes } from './routes/demo-workflow.js';
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
    const caught = error instanceof Error ? error : undefined;
    const statusCode = caught && 'statusCode' in caught ? caught.statusCode : undefined;
    const status = typeof statusCode === 'number' && Number.isInteger(statusCode)
      && statusCode >= 400 && statusCode < 500 ? statusCode : 500;
    const code = caught && 'code' in caught && typeof caught.code === 'string'
      ? caught.code : 'bad_request';
    reply.code(status).send({
      error: {
        code: status === 500 ? 'internal_error' : code,
        message: status === 500 ? 'Something went wrong' : caught!.message,
      },
    });
  });
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } });
  });

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(demoRoutes);
  await app.register(demoWorkflowRoutes);

  return app;
}
