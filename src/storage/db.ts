/**
 * Singleton SQLite connection manager.
 *
 * WAL mode is required: Johnny5 opens the same database file read-only
 * in a separate process. WAL allows concurrent readers while the daemon
 * is writing, preventing SQLITE_BUSY errors on the Johnny5 side.
 *
 * Migration safety: every migration runs inside an explicit transaction
 * so a crash mid-migration leaves the database in its previous state.
 * The schema_migrations table records what has been applied.
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { PATHS } from '../config/paths.js';
import { MIGRATIONS } from './schema.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('db');

let _db: Database.Database | null = null;

/**
 * Returns the singleton database connection, creating and migrating it on
 * first call. Subsequent calls return the cached instance immediately.
 */
export function getDb(): Database.Database {
  if (_db !== null) return _db;

  // Ensure the data directory exists before SQLite tries to create the file.
  fs.mkdirSync(path.dirname(PATHS.db), { recursive: true });

  log.info(`Opening database at ${PATHS.db}`);
  _db = new Database(PATHS.db);

  // WAL mode: allows Johnny5 to read while the daemon writes.
  _db.pragma('journal_mode = WAL');

  // Enforce REFERENCES constraints — SQLite ignores them by default.
  _db.pragma('foreign_keys = ON');

  // NORMAL is safe with WAL; FULL is the default and much slower.
  _db.pragma('synchronous = NORMAL');

  // busy_timeout: required when multiple connections write to the same DB
  // (e.g. analyzer writes while a reader queries). 5s ample.
  _db.pragma('busy_timeout = 5000');

  runMigrations(_db);

  return _db;
}

/**
 * Applies any pending migrations in ascending version order.
 * Each migration runs inside its own transaction.
 */
function runMigrations(db: Database.Database): void {
  // Bootstrap: the migrations table itself must exist before we query it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      applied_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      description TEXT
    )
  `);

  const appliedVersions = new Set<number>(
    (
      db
        .prepare('SELECT version FROM schema_migrations ORDER BY version ASC')
        .all() as Array<{ version: number }>
    ).map((r) => r.version),
  );

  const pending = MIGRATIONS.filter((m) => !appliedVersions.has(m.version)).sort(
    (a, b) => a.version - b.version,
  );

  if (pending.length === 0) {
    log.debug('Database schema is up to date');
    return;
  }

  for (const migration of pending) {
    log.info(`Applying migration v${migration.version}: ${migration.description}`);

    // Wrap each migration in a transaction so partial application is impossible.
    const applyMigration = db.transaction(() => {
      db.exec(migration.sql);
      db
        .prepare(
          'INSERT INTO schema_migrations (version, description) VALUES (?, ?)',
        )
        .run(migration.version, migration.description);
    });

    try {
      applyMigration();
      log.info(`Migration v${migration.version} applied successfully`);
    } catch (err) {
      log.error(`Migration v${migration.version} failed — database rolled back`, err);
      throw err;
    }
  }
}

/**
 * Closes the database connection. Safe to call when no connection is open.
 * After calling this, the next call to getDb() will open a fresh connection.
 */
export function closeDb(): void {
  if (_db !== null) {
    log.info('Closing database connection');
    _db.close();
    _db = null;
  }
}
