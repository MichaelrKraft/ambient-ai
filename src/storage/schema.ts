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
    version: 3,
    description: 'LeadSpot foundation: contact mirror, self-identity, daemon credentials, cost telemetry',
    sql: `
-- contact_mirror: synced from cloud every 15 min via GET /api/contacts/sync.
-- A row with deleted=1 is a tombstone; lookupContact() ignores deleted rows.
CREATE TABLE IF NOT EXISTS contact_mirror (
  contact_id    TEXT PRIMARY KEY,
  email_hash    TEXT,
  linkedin_slug TEXT,
  name_norm     TEXT,
  company_norm  TEXT,
  updated_at    INTEGER,
  deleted       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_mirror_email ON contact_mirror(email_hash);
CREATE INDEX IF NOT EXISTS ix_mirror_name  ON contact_mirror(name_norm);

-- email_alias_mirror: a contact may have several email addresses.
-- All hashes use the same normalization the backend uses (lowercase, NFKC,
-- invisible-strip, +suffix-strip).
CREATE TABLE IF NOT EXISTS email_alias_mirror (
  email_hash  TEXT NOT NULL,
  contact_id  TEXT NOT NULL,
  is_primary  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (email_hash, contact_id)
);

-- self_identity: signals matching one of the user's own email hashes are
-- dropped before promotion. Populated at OAuth login from user_email +
-- user_email_aliases, plus user-added entries via "ambient identity add".
CREATE TABLE IF NOT EXISTS self_identity (
  email_hash TEXT PRIMARY KEY,
  source     TEXT NOT NULL,
  added_at   INTEGER NOT NULL
);

-- mirror_sync_state: cursor-based incremental sync. Single row per cursor key.
CREATE TABLE IF NOT EXISTS mirror_sync_state (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- daemon_credentials_local: NON-secret data only. The refresh token lives in
-- macOS Keychain (service "ai.leadspot.ambient", account = daemon_id).
CREATE TABLE IF NOT EXISTS daemon_credentials_local (
  daemon_id        TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL,
  user_email       TEXT NOT NULL,
  device_label     TEXT NOT NULL,
  created_at       INTEGER NOT NULL
);

-- cost_telemetry: daily token-usage rollup. One row per day (YYYY-MM-DD).
-- cost_capped_today is mirrored from POST /api/daemon/cost/increment so the
-- hot path can short-circuit without round-tripping.
CREATE TABLE IF NOT EXISTS cost_telemetry (
  day                  TEXT PRIMARY KEY,
  haiku_tokens_in      INTEGER NOT NULL DEFAULT 0,
  haiku_tokens_out     INTEGER NOT NULL DEFAULT 0,
  sonnet_tokens_in     INTEGER NOT NULL DEFAULT 0,
  sonnet_tokens_out    INTEGER NOT NULL DEFAULT 0,
  signal_count         INTEGER NOT NULL DEFAULT 0,
  cost_capped_today    INTEGER NOT NULL DEFAULT 0
);
`,
  },
  {
    version: 4,
    description: 'LeadSpot promote pipeline: signals, outbox, archive, unmatched log, tombstones-seen',
    sql: `
-- leadspot_signals: local copy of every emitted signal. Mirror of cloud row,
-- daemon side. Lifecycle (§2.2 of integration plan):
--   captured → enriched → matched → held_local (60s) → queued → promoted
--   off-ramps: dropped (low conf / self / bot / cancel), held (review queue),
--              redacted (tombstoned), archived (aged out of outbox)
CREATE TABLE IF NOT EXISTS leadspot_signals (
  id                 TEXT PRIMARY KEY,
  idempotency_key    TEXT NOT NULL UNIQUE,
  contact_id         TEXT,
  contact_match_key  TEXT NOT NULL,
  source             TEXT NOT NULL,
  source_app         TEXT,
  extractor          TEXT NOT NULL,
  summary            TEXT NOT NULL,
  confidence         INTEGER NOT NULL,
  state              TEXT NOT NULL DEFAULT 'captured',
  observed_at        INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  promoted_at        INTEGER,
  cancelled_at       INTEGER,
  ocr_snippet_hash   TEXT,
  extras             TEXT,
  CHECK (state IN ('captured','enriched','matched','held_local','queued','promoted','dropped','held','redacted','archived'))
);
CREATE INDEX IF NOT EXISTS ix_local_signals_state ON leadspot_signals(state);
CREATE INDEX IF NOT EXISTS ix_local_signals_contact ON leadspot_signals(contact_id, observed_at DESC);

-- leadspot_outbox: signals waiting to be POSTed. One row per pending signal.
-- next_attempt_at drives the scheduler; backoff doubles up to 1h cap.
CREATE TABLE IF NOT EXISTS leadspot_outbox (
  signal_id       TEXT PRIMARY KEY,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error      TEXT,
  enqueued_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_outbox_next ON leadspot_outbox(next_attempt_at);

-- leadspot_signal_archive: signals moved out of outbox after 30d or permanent
-- 4xx — never to be promoted, kept for ambient diagnostics.
CREATE TABLE IF NOT EXISTS leadspot_signal_archive (
  signal_id    TEXT PRIMARY KEY,
  archived_at  INTEGER NOT NULL,
  reason       TEXT NOT NULL
);

-- leadspot_unmatched: candidates that didn't resolve to a contact. 30d TTL
-- enforced by separate cleanup tick. Used by morning-digest cold-start UX.
CREATE TABLE IF NOT EXISTS leadspot_unmatched (
  id                TEXT PRIMARY KEY,
  contact_match_key TEXT NOT NULL,
  source_app        TEXT,
  extractor         TEXT NOT NULL,
  summary           TEXT NOT NULL,
  observed_at       INTEGER NOT NULL,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_unmatched_match_key ON leadspot_unmatched(contact_match_key);
CREATE INDEX IF NOT EXISTS ix_unmatched_created ON leadspot_unmatched(created_at);

-- leadspot_tombstones_seen: cursor + applied tombstones (so we don't re-apply).
CREATE TABLE IF NOT EXISTS leadspot_tombstones_seen (
  tombstone_id TEXT PRIMARY KEY,
  applied_at   INTEGER NOT NULL
);
`,
  },
  {
    version: 5,
    description: 'Add os_username to daemon_credentials_local for shared-Mac protection',
    sql: `
-- os_username: macOS login name captured at "ambient auth login" time. The
-- daemon compares this to the currently logged-in user (id -un) before doing
-- any LeadSpot work. If they differ, the daemon enters paused_user_mismatch
-- and skips signal emission until the original user returns.
--
-- NULL is permitted because pre-v5 daemons may not have stored it; on first
-- startup after migration the daemon bootstraps the value from the current
-- uid (logging a one-time warning).
ALTER TABLE daemon_credentials_local ADD COLUMN os_username TEXT;
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
