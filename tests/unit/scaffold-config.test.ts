import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import eslintConfig from '../../eslint.config.js';
import vitestConfig from '../../vitest.config.js';

type PackageJson = {
  scripts: Record<string, string>;
};

type TsConfig = {
  compilerOptions: {
    noEmit?: boolean;
    rootDir: string;
  };
  include: string[];
  exclude: string[];
  extends?: string;
};

type LintConfig = {
  files?: string[];
  languageOptions?: {
    parserOptions?: {
      project?: string[];
      tsconfigRootDir?: string;
    };
  };
};

type ScaffoldVitestConfig = {
  test?: {
    environment?: string;
    pool?: string;
    fileParallelism?: boolean;
    coverage?: {
      include?: string[];
      exclude?: string[];
      thresholds?: {
        lines: number;
        statements: number;
        functions: number;
        branches: number;
      };
    };
  };
};

const packageJson = JSON.parse(
  readFileSync('package.json', 'utf8'),
) as PackageJson;
const tsconfig = JSON.parse(readFileSync('tsconfig.json', 'utf8')) as TsConfig;
const lintConfigs = eslintConfig as LintConfig[];
const scaffoldVitestConfig = vitestConfig as ScaffoldVitestConfig;
const testLintConfig = lintConfigs.find(
  (
    config,
  ): config is LintConfig & {
    files: string[];
    languageOptions: {
      parserOptions: {
        project: string[];
        tsconfigRootDir: string;
      };
    };
  } => {
    const parserOptions = config.languageOptions?.parserOptions;

    return (
      Array.isArray(config.files) &&
      config.files.includes('tests/**/*.ts') &&
      config.files.includes('vitest.config.ts') &&
      Array.isArray(parserOptions?.project) &&
      typeof parserOptions.tsconfigRootDir === 'string'
    );
  },
);

describe('scaffold configuration', () => {
  it('targets the required coverage areas explicitly', () => {
    expect(scaffoldVitestConfig.test?.environment).toBe('node');
    expect(scaffoldVitestConfig.test?.pool).toBe('forks');
    expect(scaffoldVitestConfig.test?.fileParallelism).toBe(false);
    expect(scaffoldVitestConfig.test?.coverage?.include).toEqual([
      'src/domain/**/*.ts',
      'src/services/**/*.ts',
      'src/sources/**/*.ts',
    ]);
    expect(scaffoldVitestConfig.test?.coverage?.exclude).toContain(
      'src/domain/models.ts',
    );
    expect(scaffoldVitestConfig.test?.coverage?.thresholds).toEqual({
      lines: 90,
      statements: 90,
      functions: 90,
      branches: 85,
    });
  });

  it('builds from src while still type-checking tests and vitest config', () => {
    expect(tsconfig.compilerOptions.rootDir).toBe('src');
    expect(tsconfig.include).toEqual(['src/**/*.ts']);
    expect(tsconfig.exclude).toContain('tests');

    expect(existsSync('tsconfig.test.json')).toBe(true);
    const tsconfigTest = JSON.parse(
      readFileSync('tsconfig.test.json', 'utf8'),
    ) as TsConfig;

    expect(tsconfigTest).toEqual({
      extends: './tsconfig.json',
      compilerOptions: {
        noEmit: true,
        rootDir: '.',
      },
      include: ['src/**/*.ts', 'tests/**/*.ts', 'vitest.config.ts'],
      exclude: ['dist', 'node_modules'],
    });

    expect(packageJson.scripts.typecheck).toBe(
      'tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit',
    );
  });

  it('uses type-aware linting for tests and vitest config', () => {
    expect(testLintConfig).toBeDefined();
    if (!testLintConfig) {
      throw new Error('Expected a type-aware ESLint config for tests');
    }

    expect(testLintConfig.languageOptions.parserOptions.project).toEqual([
      './tsconfig.test.json',
    ]);
    expect(
      typeof testLintConfig.languageOptions.parserOptions.tsconfigRootDir,
    ).toBe('string');
  });

  it('keeps the worktree safeguard in gitignore', () => {
    expect(readFileSync('.gitignore', 'utf8')).toContain('.worktrees/');
  });

  it('excludes generated plan/spec docs from prettier checks', () => {
    expect(existsSync('.prettierignore')).toBe(true);
    const prettierIgnore = readFileSync('.prettierignore', 'utf8');

    expect(prettierIgnore).toContain('docs/superpowers/plans/');
    expect(prettierIgnore).toContain('docs/superpowers/specs/');
  });
});
