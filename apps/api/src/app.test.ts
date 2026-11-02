import { describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';

// Exercise the error handler without credentials, a database or unrelated routes.
vi.mock('./env.js', () => ({
  env: { WEB_ORIGIN: 'http://localhost:5173', SESSION_SECRET: 'test-session-secret' },
  isProduction: true,
}));
vi.mock('./routes/auth.js', () => ({ authRoutes: async () => {} }));
vi.mock('./routes/health.js', () => ({ healthRoutes: async () => {} }));
vi.mock('./routes/me.js', () => ({ meRoutes: async () => {} }));
vi.mock('./routes/demo.js', () => ({ demoRoutes: async () => {} }));

describe('error handler', () => {
  it.each([
    [Object.assign(new Error('Invalid request'), { statusCode: 422, code: 'invalid_input' }),
      422, 'invalid_input', 'Invalid request'],
    [new Error('private internal details'), 500, 'internal_error', 'Something went wrong'],
    [Object.assign(new Error('bad status'), { statusCode: 200 }),
      500, 'internal_error', 'Something went wrong'],
    [{ statusCode: 400, message: 'unexpected thrown object' },
      500, 'internal_error', 'Something went wrong'],
  ])('returns a safe response for %j', async (error, status, code, message) => {
    const app = await buildApp();
    app.get('/test-error', async () => { throw error; });
    try {
      const response = await app.inject({ method: 'GET', url: '/test-error' });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ error: { code, message } });
    } finally {
      await app.close();
    }
  });
});
