/**
 * Per-day token-usage telemetry + cost cap (§15 of the integration plan).
 *
 * Two layers:
 *   1. Local cost_telemetry — atomic per-day rollup. Even if the cloud is
 *      unreachable we still count locally so the daemon can report later.
 *   2. POST /api/daemon/cost/increment — best-effort push to cloud. The
 *      cloud authoritatively says whether the user has hit today's cap.
 *      On cap, daemon enters cost_capped state and stops calling Haiku.
 *
 * Hot-path callers should use isCappedToday() (read-only) before deciding
 * to spend tokens. The actual increment + cloud push happens AFTER the
 * Haiku call returns.
 */
import type Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import type { LeadSpotClient } from './client.js';

const log = createLogger('leadspot:cost');

interface CostRow {
  day: string;
  haiku_tokens_in: number;
  haiku_tokens_out: number;
  sonnet_tokens_in: number;
  sonnet_tokens_out: number;
  signal_count: number;
  cost_capped_today: number;
}

/**
 * Increment today's Haiku totals locally, then push the delta to the cloud.
 *
 * Returns the cap status (true = capped, daemon should pause). On network
 * failure we return the *local* cached status — this means a brief offline
 * period doesn't accidentally let a capped user keep spending if they were
 * already known-capped.
 */
export async function recordHaikuUsage(
  db: Database.Database,
  client: LeadSpotClient,
  tokensIn: number,
  tokensOut: number,
): Promise<{ capped: boolean }> {
  const day = todayKey();
  // Atomic local increment. ON CONFLICT path keeps cost_capped_today as-is.
  db
    .prepare(
      `INSERT INTO cost_telemetry
         (day, haiku_tokens_in, haiku_tokens_out, signal_count, cost_capped_today)
       VALUES (?, ?, ?, 0, 0)
       ON CONFLICT(day) DO UPDATE SET
         haiku_tokens_in  = haiku_tokens_in  + excluded.haiku_tokens_in,
         haiku_tokens_out = haiku_tokens_out + excluded.haiku_tokens_out`,
    )
    .run(day, tokensIn, tokensOut);

  try {
    const res = await client.incrementCost({
      haiku_tokens_in: tokensIn,
      haiku_tokens_out: tokensOut,
    });
    if (res.cost_capped) {
      db
        .prepare(
          'UPDATE cost_telemetry SET cost_capped_today = 1 WHERE day = ?',
        )
        .run(day);
    }
    return { capped: res.cost_capped };
  } catch (err) {
    log.warn('cost increment push failed; will retry next call', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { capped: isCappedToday(db) };
  }
}

/**
 * Synchronous cap check. Reads only the local mirror — does NOT hit cloud.
 * Hot-path safe.
 */
export function isCappedToday(db: Database.Database): boolean {
  const row = db
    .prepare(
      'SELECT cost_capped_today FROM cost_telemetry WHERE day = ?',
    )
    .get(todayKey()) as { cost_capped_today: number } | undefined;
  return row !== undefined && row.cost_capped_today === 1;
}

/**
 * Read today's full row (for `ambient cost` CLI output, observability).
 */
export function getTodayUsage(db: Database.Database): CostRow {
  const row = db
    .prepare(
      `SELECT day, haiku_tokens_in, haiku_tokens_out, sonnet_tokens_in,
              sonnet_tokens_out, signal_count, cost_capped_today
         FROM cost_telemetry WHERE day = ?`,
    )
    .get(todayKey()) as CostRow | undefined;
  if (row !== undefined) return row;
  return {
    day: todayKey(),
    haiku_tokens_in: 0,
    haiku_tokens_out: 0,
    sonnet_tokens_in: 0,
    sonnet_tokens_out: 0,
    signal_count: 0,
    cost_capped_today: 0,
  };
}

/** YYYY-MM-DD in local TZ. We use local because that's what the user feels;
 *  cloud-side cap math is also user-TZ keyed (per §13). */
function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
