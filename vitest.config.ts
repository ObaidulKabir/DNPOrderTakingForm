import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 35000,
    hookTimeout: 35000,
    poolOptions: {
      forks: {
        execArgv: ['--experimental-sqlite', '--no-warnings'],
      },
    },
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/domain/types.ts', 'src/server.ts', 'src/repositories/IDataRepository.ts'],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 75,
        statements: 85,
      },
    },
  },
});
