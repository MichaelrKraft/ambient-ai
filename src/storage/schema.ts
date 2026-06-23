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
  {
    version: 2,
    description: 'Add web_captures table for browser deep read deduplication',
    sql: `
CREATE TABLE IF NOT EXISTS web_captures (
  url         TEXT PRIMARY KEY,
  title       TEXT,
  captured_at TEXT NOT NULL
);
`,
  },
  {
    version: 6,
    description: 'Add tasks table for auto-captured commitments (Air Jelly Tasks feature)',
    sql: `
-- tasks: commitments/to-dos auto-extracted from screen activity by the
-- ActivityAnalyzer each cycle.
--
-- Dedup is enforced by content_hash (UNIQUE), a hash of the normalized
-- (lowercase, trimmed, whitespace-collapsed) task content. Inserts use
-- INSERT OR IGNORE so the same on-screen commitment seen across many polling
-- cycles produces exactly one row — mirroring the web_captures idiom.
--
-- due_date is a resolved absolute local date (YYYY-MM-DD) or NULL; the
-- analyzer resolves relative phrases ("Friday", "EOD") against an injected
-- anchor date so we never store an ambiguous phrase.
--
-- status lifecycle: 'open' (default) → 'done' (closed via MCP/dashboard) or
-- 'dismissed' (aged out by autoDismissStaleTasks during the daily export).
CREATE TABLE IF NOT EXISTS tasks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  content        TEXT NOT NULL,
  content_hash   TEXT NOT NULL UNIQUE,
  source_apps    TEXT,
  due_date       TEXT,
  status         TEXT NOT NULL DEFAULT 'open',
  confidence     REAL,
  created_at     TEXT NOT NULL,
  completed_at   TEXT,
  is_pii_flagged INTEGER NOT NULL DEFAULT 0,
  CHECK (status IN ('open','done','dismissed'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks(status, due_date);
`,
  },
];
