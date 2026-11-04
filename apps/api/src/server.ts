import { buildApp } from './app.js';
import { pool } from './db/client.js';
import { env, githubConfigured } from './env.js';
import { recoverStaleRuns } from './lib/demo-runner.js';

const app = await buildApp();

// Judge regrading is intended for a local copy.
await app.listen({ host: '127.0.0.1', port: env.PORT });

// Runs whose worker died with the previous process are marked interrupted, never resent.
await recoverStaleRuns().catch((err: unknown) => app.log.warn({ err }, 'Run recovery skipped'));

if (!githubConfigured) {
  app.log.warn('GitHub sign-in is not configured yet: set GITHUB_CLIENT_ID.');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
