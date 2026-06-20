import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/storage/database.js';

function createDatabasePath(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'bsag-storage-'));

  return {
    dir,
    dbPath: join(dir, 'storage.sqlite'),
  };
}

describe('openDatabase', () => {
  it('enables WAL mode, foreign keys, and a 5-second busy timeout', () => {
    const { dir, dbPath } = createDatabasePath();
    const handle = openDatabase(dbPath);

    try {
      expect(handle.connection.pragma('journal_mode', { simple: true })).toBe(
        'wal',
      );
      expect(handle.connection.pragma('foreign_keys', { simple: true })).toBe(
        1,
      );
      expect(handle.connection.pragma('busy_timeout', { simple: true })).toBe(
        5000,
      );
    } finally {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies migrations idempotently and provisions the storage tables', () => {
    const { dir, dbPath } = createDatabasePath();
    const first = openDatabase(dbPath);
    let firstMigrationCount = 0;

    try {
      const firstRows = first.connection
        .prepare<
          [],
          { count: number }
        >('SELECT COUNT(*) AS count FROM schema_migrations')
        .all();
      firstMigrationCount = firstRows[0]?.count ?? 0;
      const tableRows = first.connection
        .prepare<
          [],
          { name: string }
        >("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all();
      const tableNames = tableRows.map((row) => row.name);

      expect(firstMigrationCount).toBeGreaterThan(0);
      expect(tableNames).toEqual(
        expect.arrayContaining([
          'delay_observations',
          'external_impacts',
          'realtime_snapshots',
          'schema_migrations',
          'service_notices',
          'source_state',
        ]),
      );
    } finally {
      first.close();
    }

    const second = openDatabase(dbPath);

    try {
      const secondRows = second.connection
        .prepare<
          [],
          { count: number }
        >('SELECT COUNT(*) AS count FROM schema_migrations')
        .all();
      const secondMigrationCount = secondRows[0]?.count ?? 0;

      expect(secondMigrationCount).toBeGreaterThan(0);
      expect(secondMigrationCount).toBe(firstMigrationCount);
    } finally {
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
