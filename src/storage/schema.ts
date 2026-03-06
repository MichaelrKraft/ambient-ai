/**
 * SQLite schema definitions and migration runner.
 *
 * Each entry in MIGRATIONS is applied exactly once, tracked in schema_migrations.
 * Migrations run inside a transaction so partial application is impossible.
 */

export interface Migration {
  version: number;
  description: string;
  sql: string;
}

/**
 * The complete initial schema.
 *
 * Design notes:
 * - FTS5 uses content= (external content table) to avoid double-storing text.
 *   Three triggers keep the FTS index in sync with knowledge_items.
 * - apps_seen and source_apps store JSON arrays as TEXT; callers marshal/unmarshal.
 * - daemon_state is a simple key-value table for mutable singleton values
 *   (last poll time, daily token counters, etc.).
 */
const INITIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  description TEXT
);

CREATE TABLE IF NOT EXISTS activity_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  period_start DATETIME NOT NULL,
  period_end   DATETIME NOT NULL,
  primary_app  TEXT,
  summary      TEXT,
  category     TEXT,
  apps_seen    TEXT,
  token_cost   INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_activity_time ON activity_sessions(period_start);

CREATE TABLE IF NOT EXISTS knowledge_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  content      TEXT NOT NULL,
  category     TEXT,
  source_apps  TEXT,
  extracted_at DATETIME NOT NULL,
  is_pii_flagged INTEGER DEFAULT 0
);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  content,
  content=knowledge_items,
  content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS knowledge_fts_insert
  AFTER INSERT ON knowledge_items
BEGIN
  INSERT INTO knowledge_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS knowledge_fts_delete
  AFTER DELETE ON knowledge_items
BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, content)
  VALUES ('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS knowledge_fts_update
  AFTER UPDATE ON knowledge_items
BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, content)
  VALUES ('delete', old.id, old.content);
  INSERT INTO knowledge_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE IF NOT EXISTS error_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  error_text       TEXT NOT NULL,
  app_name         TEXT,
  first_seen       DATETIME NOT NULL,
  last_seen        DATETIME NOT NULL,
  occurrence_count INTEGER DEFAULT 1,
  resolved_at      DATETIME,
  is_notified      INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS goals (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  created_at  DATETIME NOT NULL,
  target_date DATETIME,
  status      TEXT DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS goal_progress (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id    TEXT NOT NULL REFERENCES goals(id),
  timestamp  DATETIME NOT NULL,
  evidence   TEXT,
  confidence REAL
);

CREATE TABLE IF NOT EXISTS notifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  triggered_at DATETIME NOT NULL,
  content      TEXT NOT NULL,
  channel      TEXT,
  feedback     TEXT
);

CREATE TABLE IF NOT EXISTS daemon_state (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Initial schema',
    sql: INITIAL_SCHEMA,
  },
];
