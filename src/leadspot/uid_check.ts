/**
 * Shared-Mac protection (§2.5 of the integration plan).
 *
 * Some founders share a Mac with a spouse; the OS-level user account
 * uniquely identifies whose work this daemon should track. Before doing
 * any LeadSpot work the daemon checks that the currently-logged-in user
 * matches the user who ran `ambient auth login`. If they differ, the
 * daemon enters paused_user_mismatch state and skips work until the
 * original user returns (re-checked every 30s by the daemon main loop).
 *
 * Pure function — no DB writes, no logging, no exceptions on the happy
 * path. Returns ok=true if the uids match (or if we have no baseline yet
 * to compare against — bootstrap case).
 */
import os from 'node:os';
import type Database from 'better-sqlite3';

export interface UidCheckResult {
  /** True if it is safe to do LeadSpot work for this user. */
  ok: boolean;
  /** The OS username we expected (from daemon_credentials_local). */
  expectedUid?: string;
  /** The OS username we observed right now. */
  currentUid: string;
  /** True if we just bootstrapped the column for a pre-v5 daemon row. */
  bootstrapped?: boolean;
}

/**
 * Read the current OS username. Falls back to env if `os.userInfo()` is
 * unavailable (rare; some sandboxed shells throw).
 */
export function currentOsUsername(): string {
  try {
    const info = os.userInfo();
    if (info.username !== '') return info.username;
  } catch {
    // fall through
  }
  return process.env.USER ?? process.env.LOGNAME ?? '';
}

/**
 * Compare the running user against the user who authenticated.
 *
 * Bootstrap case: if the row exists but `os_username` is NULL (pre-v5 daemon
 * upgraded in place), populate it with the current uid and return ok=true.
 * We log this as bootstrap so the daemon main loop can warn once.
 *
 * No-credentials case: if no row exists at all (Obsidian-only user, or
 * pre-login state), return ok=true. The daemon already gates leadspot work
 * on `config.leadspot.enabled`, so this function is only consulted on the
 * leadspot-enabled path.
 */
export function verifySameUser(
  db: Database.Database,
  currentUid: string = currentOsUsername(),
): UidCheckResult {
  const row = db
    .prepare(
      'SELECT daemon_id, os_username FROM daemon_credentials_local LIMIT 1',
    )
    .get() as { daemon_id: string; os_username: string | null } | undefined;

  if (row === undefined) {
    // No credentials row → caller should not be calling us, but fail-safe.
    return { ok: true, currentUid };
  }

  if (row.os_username === null || row.os_username === '') {
    // Bootstrap: populate the column so subsequent checks have a baseline.
    db
      .prepare('UPDATE daemon_credentials_local SET os_username = ? WHERE daemon_id = ?')
      .run(currentUid, row.daemon_id);
    return { ok: true, currentUid, expectedUid: currentUid, bootstrapped: true };
  }

  return {
    ok: row.os_username === currentUid,
    expectedUid: row.os_username,
    currentUid,
  };
}
