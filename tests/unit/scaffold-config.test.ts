import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import vitestConfig from '../../vitest.config.js';

describe('scaffold configuration', () => {
  it('targets the required coverage areas explicitly', () => {
    expect(vitestConfig.test?.coverage?.include).toEqual([
      'src/domain/**/*.ts',
      'src/services/**/*.ts',
      'src/**/*parser*.ts',
      'src/**/*Parser*.ts',
    ]);
  });

  it('keeps the worktree safeguard in gitignore', () => {
    expect(readFileSync('.gitignore', 'utf8')).toContain('.worktrees/');
  });
});
