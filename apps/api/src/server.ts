import { buildApp } from './app.js';
import { pool } from './db/client.js';
import { env, githubConfigured } from './env.js';

const app = await buildApp();

// 0.0.0.0 so Modal (and Docker) can reach it (R-2.10).
await app.listen({ host: '0.0.0.0', port: env.PORT });

if (!githubConfigured) {
  app.log.warn('GitHub sign-in is not configured yet: set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
