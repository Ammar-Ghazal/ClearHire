import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Postgres tests share one database, and the demo routes read across all rows, so files that
    // run at once see each other's rows mid-write or mid-delete. One file at a time keeps them stable.
    fileParallelism: false,
  },
});
