import { buildApp } from './app.js';
import { pool } from './db/client.js';
import { env, githubConfigured } from './env.js';
import { recoverStaleRuns, safeErrorCode, startAnalysisWorker } from './lib/demo-runner.js';

const app = await buildApp();

// 0.0.0.0 so Modal (and Docker) can reach it (R-2.10).
await app.listen({ host: '0.0.0.0', port: env.PORT });

// Runs whose worker died with the previous process are marked interrupted, never resent.
await recoverStaleRuns().catch((err: unknown) => app.log.warn({ err }, 'Run recovery skipped'));

// Grades every subject without a result yet, one at a time; failures are never retried.
const stopWorker = startAnalysisWorker({
  onError: (err) => app.log.warn({ code: safeErrorCode(err) }, 'Demo analysis failed'),
});

if (!githubConfigured) {
  app.log.warn('GitHub sign-in is not configured yet: set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    stopWorker();
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
