/**
 * Daemon pause state — backs `ambient pause` / `ambient resume` CLI commands.
 *
 * Storage: a single row in the existing `daemon_state` key-value table under
 * key `pause_until_ms`. Value is either a unix-ms expiration or the literal
 * string "forever". Absence of the row means "not paused."
 *
 * The polling loop calls `isPaused(db)` at the top of each cycle and skips
 * its work when true, halting the ActivityAnalyzer cycle — pause is global.
 */
import type Database from 'better-sqlite3';

const KEY = 'pause_until_ms';

export type PauseDuration = '1h' | 'today' | 'forever';

/**
 * Returns true if the daemon is currently paused.
 *
 * If the pause_until value is in the past we proactively clear the row so
 * the next read is fast and `daemon_state` doesn't accumulate stale data.
 */
export function isPaused(db: Database.Database): boolean {
  const row = db
    .prepare('SELECT value FROM daemon_state WHERE key = ?')
    .get(KEY) as { value: string } | undefined;
  if (row === undefined) return false;
  if (row.value === 'forever') return true;
  const until = Number(row.value);
  if (!Number.isFinite(until)) return false;
  if (until > Date.now()) return true;
  // Expired — clean up.
  db.prepare('DELETE FROM daemon_state WHERE key = ?').run(KEY);
  return false;
}

/**
 * Set the pause sentinel. Pass `null` to clear (resume).
 *
 * Accepts either a unix-ms expiration, the literal "forever", or null.
 */
export function setPause(db: Database.Database, until: number | 'forever' | null): void {
  if (until === null) {
    db.prepare('DELETE FROM daemon_state WHERE key = ?').run(KEY);
    return;
  }
  const value = until === 'forever' ? 'forever' : String(until);
  db
    .prepare(
      `INSERT INTO daemon_state (key, value, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    )
    .run(KEY, value);
}

/**
 * Translate a CLI duration argument to a unix-ms expiration (or 'forever').
 *
 * - '1h'      → now + 1 hour
 * - 'today'   → end of today (local TZ)
 * - 'forever' → 'forever' sentinel
 */
export function parsePauseDuration(arg: string): number | 'forever' {
  switch (arg) {
    case '1h':
      return Date.now() + 60 * 60 * 1000;
    case 'today': {
      const d = new Date();
      d.setHours(23, 59, 59, 999);
      return d.getTime();
    }
    case 'forever':
      return 'forever';
    default:
      throw new Error(`Unknown pause duration "${arg}". Expected: 1h | today | forever`);
  }
}

/**
 * Inspect the pause state for the CLI `ambient status` / `ambient diagnostics`
 * commands. Returns null when not paused.
 */
export function getPauseInfo(
  db: Database.Database,
): { until: number | 'forever' } | null {
  const row = db
    .prepare('SELECT value FROM daemon_state WHERE key = ?')
    .get(KEY) as { value: string } | undefined;
  if (row === undefined) return null;
  if (row.value === 'forever') return { until: 'forever' };
  const ms = Number(row.value);
  if (!Number.isFinite(ms)) return null;
  if (ms <= Date.now()) return null;
  return { until: ms };
}
