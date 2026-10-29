import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 20000,
    hookTimeout: 20000,
    poolOptions: {
      forks: {
        execArgv: ['--experimental-sqlite', '--no-warnings'],
      },
    },
    pool: 'forks',
  },
});
