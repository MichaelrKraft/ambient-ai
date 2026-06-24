/**
 * ChromeHistory — read-only per-site time breakdown from Chrome's history DB.
 *
 * Why this exists: Ambient's activity_sessions only record the foreground *app*
 * ("Google Chrome"), not which sites were visited. Screenpipe's per-window
 * metadata is too sparse/unreliable here to reconstruct per-site dwell time, but
 * Chrome's own history database records foreground time per page in
 * visits.visit_duration. We read it on demand to power the dashboard's
 * "By website" breakdown.
 *
 * Privacy: this is strictly read-only and nothing is persisted. We copy Chrome's
 * locked DB to a temp file, aggregate to DOMAIN-level minutes in memory, delete
 * the copy, and return only { label, minutes } rows. URLs and domains are never
 * logged and never written into Ambient's database.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import type { TimeBreakdownRow } from '../storage/AmbientStore.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('chrome-history');

/** Chrome's Default-profile history DB on macOS. */
const CHROME_HISTORY_PATH = path.join(
  os.homedir(),
  'Library/Application Support/Google/Chrome/Default/History',
);

/**
 * Per-visit cap (microseconds). Chrome's visit_duration counts time a page is
 * the active tab even when Chrome isn't the frontmost app, so a tab left open
 * all day (or playing media) inflates totals. Capping each visit at 30 minutes
 * keeps the per-site ranking realistic.
 */
const VISIT_CAP_US = 30 * 60 * 1_000_000;

/** Microseconds between 1601-01-01 (Chrome epoch) and 1970-01-01 (Unix epoch). */
const CHROME_EPOCH_OFFSET_SECONDS = 11_644_473_600;

interface RawVisitRow {
  url: string;
  dur_us: number | bigint;
}

/**
 * Returns per-domain foreground minutes from Chrome over the last `hoursBack`
 * hours, largest first. Returns [] if Chrome isn't installed or anything fails —
 * this feature must never break the /api/breakdown endpoint.
 */
export function getSiteTimeBreakdown(hoursBack: number): TimeBreakdownRow[] {
  if (!fs.existsSync(CHROME_HISTORY_PATH)) {
    return [];
  }

  const tempPaths: string[] = [];
  try {
    // Chrome holds History open in WAL mode; copy the DB + its sidecar files to
    // a private temp location and read the copy so we never touch the live file.
    const stamp = `${process.pid}-${hoursBack}`;
    const base = path.join(os.tmpdir(), `ambient-chrome-${stamp}-History`);
    for (const suffix of ['', '-wal', '-shm']) {
      const src = CHROME_HISTORY_PATH + suffix;
      if (fs.existsSync(src)) {
        const dest = base + suffix;
        fs.copyFileSync(src, dest);
        tempPaths.push(dest);
      }
    }

    const rows = readVisits(base, hoursBack);
    return aggregateByDomain(rows);
  } catch (err) {
    // Never surface Chrome-read failures to the caller; degrade to no sites.
    log.warn('Chrome history read failed (non-fatal)', { error: String(err) });
    return [];
  } finally {
    for (const p of tempPaths) {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        // Best-effort cleanup; a leftover temp copy is harmless.
      }
    }
  }
}

/** Opens the temp copy read-only and returns capped per-URL durations. */
function readVisits(dbPath: string, hoursBack: number): RawVisitRow[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    // Chrome timestamps are microseconds since 1601; the bound exceeds 2^53 so
    // it must be bound as a BigInt to avoid precision loss.
    const sinceUnixSeconds = Math.floor((Date.now() - hoursBack * 3_600_000) / 1000);
    const sinceChrome = BigInt(sinceUnixSeconds + CHROME_EPOCH_OFFSET_SECONDS) * 1_000_000n;

    return db
      .prepare(
        `SELECT u.url AS url,
                SUM(CASE WHEN v.visit_duration > ? THEN ? ELSE v.visit_duration END) AS dur_us
         FROM visits v
         JOIN urls u ON u.id = v.url
         WHERE v.visit_time > ? AND u.url LIKE 'http%'
         GROUP BY u.url`,
      )
      .all(VISIT_CAP_US, VISIT_CAP_US, sinceChrome) as RawVisitRow[];
  } finally {
    db.close();
  }
}

/**
 * Collapses per-URL durations to per-domain minutes (stripping a leading
 * "www."), sorted largest first. Rows under 1 minute are dropped as noise.
 */
function aggregateByDomain(rows: RawVisitRow[]): TimeBreakdownRow[] {
  const minutesByDomain = new Map<string, number>();

  for (const row of rows) {
    let host: string;
    try {
      host = new URL(row.url).hostname.replace(/^www\./, '');
    } catch {
      continue; // Skip unparseable URLs.
    }
    if (!host) continue;

    const minutes = Number(row.dur_us) / 60_000_000;
    minutesByDomain.set(host, (minutesByDomain.get(host) ?? 0) + minutes);
  }

  const result = [...minutesByDomain.entries()]
    .map(([label, minutes]) => ({ label, minutes: Math.round(minutes) }))
    .filter((r) => r.minutes >= 1)
    .sort((a, b) => b.minutes - a.minutes);

  log.info(`Site breakdown: ${result.length} domain(s)`);
  return result;
}
