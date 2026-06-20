import type Database from 'better-sqlite3';

export interface Migration {
  id: string;
  apply(database: Database.Database): void;
}

export const migrations: readonly Migration[] = [
  {
    id: '001_initial_storage',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS realtime_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL,
          snapshot_at TEXT NOT NULL,
          fetched_at TEXT NOT NULL,
          UNIQUE (source, snapshot_at)
        );

        CREATE TABLE IF NOT EXISTS delay_observations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          snapshot_id INTEGER NOT NULL REFERENCES realtime_snapshots(id) ON DELETE CASCADE,
          line_id TEXT NOT NULL,
          direction TEXT,
          stop_name TEXT,
          scheduled_at TEXT,
          observed_at TEXT NOT NULL,
          delay_seconds INTEGER NOT NULL,
          trip_id TEXT,
          stop_sequence INTEGER,
          provenance_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS service_notices (
          source TEXT NOT NULL,
          id TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          details TEXT,
          lines_json TEXT NOT NULL,
          valid_from TEXT,
          valid_to TEXT,
          severity TEXT NOT NULL,
          provenance_json TEXT NOT NULL,
          content_hash TEXT,
          fetched_at TEXT NOT NULL,
          PRIMARY KEY (source, id)
        );

        CREATE TABLE IF NOT EXISTS external_impacts (
          source TEXT NOT NULL,
          id TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          details TEXT,
          corridor_ids_json TEXT NOT NULL,
          starts_at TEXT,
          ends_at TEXT,
          category TEXT NOT NULL,
          severity TEXT NOT NULL,
          provenance_json TEXT NOT NULL,
          content_hash TEXT,
          fetched_at TEXT NOT NULL,
          PRIMARY KEY (source, id)
        );

        CREATE TABLE IF NOT EXISTS source_state (
          source TEXT PRIMARY KEY,
          fetched_at TEXT NOT NULL,
          content_hash TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_realtime_snapshots_lookup
          ON realtime_snapshots (snapshot_at DESC, source);

        CREATE INDEX IF NOT EXISTS idx_delay_observations_line_snapshot
          ON delay_observations (line_id, snapshot_id);

        CREATE INDEX IF NOT EXISTS idx_service_notices_fetched_at
          ON service_notices (source, fetched_at DESC);

        CREATE INDEX IF NOT EXISTS idx_external_impacts_fetched_at
          ON external_impacts (source, fetched_at DESC);
      `);
    },
  },
  {
    id: '002_realtime_observation_enrichment',
    apply(database) {
      database.exec(`
        ALTER TABLE delay_observations
          ADD COLUMN entity_id TEXT;

        ALTER TABLE delay_observations
          ADD COLUMN has_usable_delay INTEGER NOT NULL DEFAULT 1;

        ALTER TABLE delay_observations
          ADD COLUMN schedule_relationship TEXT;

        ALTER TABLE delay_observations
          ADD COLUMN update_count INTEGER NOT NULL DEFAULT 1;
      `);
    },
  },
  {
    id: '003_service_notice_stops',
    apply(database) {
      database.exec(`
        ALTER TABLE service_notices
          ADD COLUMN stop_names_json TEXT NOT NULL DEFAULT '[]';
      `);
    },
  },
];

export function applyMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const readAppliedMigrationIds = database.prepare<[], { id: string }>(
    'SELECT id FROM schema_migrations ORDER BY id',
  );
  const insertAppliedMigration = database.prepare<[string, string]>(
    'INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)',
  );

  database.transaction(() => {
    const appliedMigrationIds = new Set(
      readAppliedMigrationIds.all().map((row) => row.id),
    );

    for (const migration of migrations) {
      if (appliedMigrationIds.has(migration.id)) {
        continue;
      }

      migration.apply(database);
      insertAppliedMigration.run(migration.id, new Date().toISOString());
    }
  })();
}
