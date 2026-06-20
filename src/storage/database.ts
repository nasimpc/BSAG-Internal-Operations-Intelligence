import Database from 'better-sqlite3';

import { applyMigrations } from './migrations.js';

export interface DatabaseHandle {
  path: string;
  connection: Database.Database;
  close(): void;
}

export function openDatabase(path: string): DatabaseHandle {
  const connection = new Database(path);

  connection.pragma('journal_mode = WAL');
  connection.pragma('foreign_keys = ON');
  connection.pragma('busy_timeout = 5000');

  applyMigrations(connection);

  return {
    path,
    connection,
    close(): void {
      if (connection.open) {
        connection.close();
      }
    },
  };
}
