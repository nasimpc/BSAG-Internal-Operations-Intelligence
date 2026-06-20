import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: [
        'src/domain/**/*.ts',
        'src/services/**/*.ts',
        'src/**/*parser*.ts',
        'src/**/*Parser*.ts',
      ],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 85,
      },
    },
  },
});
