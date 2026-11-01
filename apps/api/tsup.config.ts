import { defineConfig } from 'tsup';

// Bundles the API into dist/ for `node dist/server.js` (Modal runs this).
// The shared workspace package is TypeScript source, so it is bundled in.
export default defineConfig({
  entry: ['src/server.ts', 'src/db/migrate.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: ['@clearhire/shared'],
});
