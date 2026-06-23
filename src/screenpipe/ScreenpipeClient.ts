import { SCREENPIPE_BASE_URL } from '../config/paths.js';
import { createLogger } from '../shared/logger.js';
import { withRetry } from '../shared/retry.js';
import { minutesAgoISO, hoursAgoISO } from '../shared/time.js';
import type {
  HealthResponse,
  OcrEntry,
  RawSqlRequest,
  RawSqlResponse,
  ScreenpipeHealthStatus,
  ScreenpipeOCRContent,
  ScreenpipeResult,
  ScreenpipeSearchResponse,
} from './types.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 100;
const MAX_TOTAL_RESULTS = 500;
const MIN_TEXT_LENGTH = 20;
const SIMILARITY_THRESHOLD = 0.85;
// Screenpipe's /search can take ~10s+ on a large OCR DB (hundreds of
// thousands of rows). 10s was too tight and aborted valid queries; 25s gives
// headroom so slow-but-successful fetches aren't dropped.
const FETCH_TIMEOUT_MS = 25_000;
const RAW_SQL_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 3_000;

// Apps whose OCR output we always discard (UI chrome, system popups, etc.)
const DEFAULT_IGNORE_APPS = [
  'Dock',
  'SystemUIServer',
  'NotificationCenter',
  'Control Centre',
  'loginwindow',
  'WindowServer',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Fast prefix-based text similarity.
 * Returns a value in [0, 1]; 1 means identical.
 * Used to detect near-duplicate OCR frames from the same window.
 */
function textSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  let prefixLen = 0;
  while (prefixLen < shorter.length && shorter[prefixLen] === longer[prefixLen]) {
    prefixLen++;
  }
  return prefixLen / longer.length;
}

/**
 * Collapse near-duplicate OCR entries within each (appName, windowName) group.
 * Adjacent frames that are >SIMILARITY_THRESHOLD similar are reduced to the
 * latest one.  Returns entries sorted ascending by timestamp.
 */
function deduplicateOcrEntries(entries: OcrEntry[]): OcrEntry[] {
  if (entries.length === 0) return entries;

  // Group by app+window combo
  const groups = new Map<string, OcrEntry[]>();
  for (const entry of entries) {
    const key = `${entry.appName}\x00${entry.windowName}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [entry]);
    } else {
      group.push(entry);
    }
  }

  const deduplicated: OcrEntry[] = [];
  for (const group of groups.values()) {
    // Sort ascending by timestamp so we always keep the *latest* duplicate
    group.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const kept: OcrEntry[] = [];
    for (const entry of group) {
      if (kept.length === 0) {
        kept.push(entry);
        continue;
      }
      const prev = kept[kept.length - 1];
      if (textSimilarity(prev.text, entry.text) > SIMILARITY_THRESHOLD) {
        // Replace with the newer entry
        kept[kept.length - 1] = entry;
      } else {
        kept.push(entry);
      }
    }
    deduplicated.push(...kept);
  }

  // Return globally sorted ascending by timestamp
  deduplicated.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return deduplicated;
}

/**
 * Type-guard: narrow a ScreenpipeResult's content to OCR.
 */
function isOcrResult(result: ScreenpipeResult): result is ScreenpipeResult & {
  content: ScreenpipeOCRContent;
} {
  return result.type === 'OCR';
}

/**
 * Map a raw OCR content object to our clean OcrEntry shape.
 */
function toOcrEntry(content: ScreenpipeOCRContent): OcrEntry {
  return {
    text: content.text,
    appName: content.app_name,
    windowName: content.window_name,
    timestamp: content.timestamp,
  };
}

/**
 * Build a fetch AbortController that times out after `ms` milliseconds.
 */
function makeAbortController(ms: number): AbortController {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller;
}

// ── Client ────────────────────────────────────────────────────────────────────

export class ScreenpipeClient {
  private readonly baseUrl: string;
  private readonly log: ReturnType<typeof createLogger>;
  private readonly ignoreApps: Set<string>;

  constructor(baseUrl?: string, ignoreApps: string[] = []) {
    this.baseUrl = baseUrl ?? SCREENPIPE_BASE_URL;
    this.log = createLogger('screenpipe');
    this.ignoreApps = new Set([...DEFAULT_IGNORE_APPS, ...ignoreApps]);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Check whether the Screenpipe daemon is reachable.
   */
  async checkHealth(): Promise<ScreenpipeHealthStatus> {
    const controller = makeAbortController(HEALTH_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        this.log.warn(`Health check returned HTTP ${response.status}`);
        return { running: false };
      }
      const body = (await response.json()) as HealthResponse;
      return { running: true, version: body.version };
    } catch (err) {
      this.log.warn('Screenpipe not reachable', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { running: false };
    }
  }

  /**
   * Fetch OCR entries captured since `since` (ISO 8601 string).
   * Handles pagination automatically; caps at MAX_TOTAL_RESULTS.
   * Filters out short entries and ignored apps.
   */
  async getOcrSince(since: string, limitPerPage: number = DEFAULT_LIMIT): Promise<OcrEntry[]> {
    const allEntries: OcrEntry[] = [];
    let offset = 0;
    let totalKnown = Infinity;

    while (allEntries.length < MAX_TOTAL_RESULTS && offset < totalKnown) {
      const pageLimit = Math.min(limitPerPage, MAX_TOTAL_RESULTS - allEntries.length);
      const url =
        `${this.baseUrl}/search` +
        `?content_type=ocr` +
        `&start_time=${encodeURIComponent(since)}` +
        `&limit=${pageLimit}` +
        `&offset=${offset}`;

      let page: ScreenpipeSearchResponse;
      try {
        page = await withRetry(
          () => this.fetchJson<ScreenpipeSearchResponse>(url, FETCH_TIMEOUT_MS),
          { maxAttempts: 3, baseDelayMs: 2_000 },
        );
      } catch (err) {
        this.log.warn('Failed to fetch OCR page from Screenpipe', {
          url,
          error: err instanceof Error ? err.message : String(err),
        });
        break;
      }

      totalKnown = page.pagination.total;

      for (const result of page.data) {
        if (!isOcrResult(result)) continue;
        const content = result.content;

        // Skip short / noisy entries
        if (content.text.trim().length < MIN_TEXT_LENGTH) continue;

        // Skip ignored apps
        if (this.ignoreApps.has(content.app_name)) continue;

        allEntries.push(toOcrEntry(content));
      }

      offset += pageLimit;

      // If the page returned fewer items than requested, we've exhausted results
      if (page.data.length < pageLimit) break;
    }

    return allEntries;
  }

  /**
   * Fetch recent OCR text for the last `sinceMinutes` minutes, deduplicated.
   */
  async getRecentOcrText(sinceMinutes: number): Promise<OcrEntry[]> {
    const since = minutesAgoISO(sinceMinutes);
    const raw = await this.getOcrSince(since);

    const before = raw.length;
    const deduplicated = deduplicateOcrEntries(raw);
    const after = deduplicated.length;

    if (before !== after) {
      this.log.info(`Deduplicated ${before}→${after} entries from Screenpipe`);
    }

    return deduplicated;
  }

  /**
   * Query Screenpipe's SQLite database directly for OCR text containing error
   * keywords from the last `hoursBack` hours.
   *
   * Falls back to client-side filtering of `getRecentOcrText` when the
   * raw_sql endpoint is unavailable (older Screenpipe versions).
   */
  async queryErrorsFromOcr(hoursBack: number): Promise<OcrEntry[]> {
    const since = hoursAgoISO(hoursBack);

    const body: RawSqlRequest = {
      query: [
        'SELECT text, app_name, window_name, timestamp',
        'FROM ocr_text',
        'WHERE timestamp > ?',
        'AND (',
        "  text LIKE '%Error%'",
        "  OR text LIKE '%error:%'",
        "  OR text LIKE '%FAILED%'",
        "  OR text LIKE '%Exception%'",
        "  OR text LIKE '%npm ERR%'",
        "  OR text LIKE '%SyntaxError%'",
        "  OR text LIKE '%TypeError%'",
        "  OR text LIKE '%Cannot find%'",
        "  OR text LIKE '%ENOENT%'",
        ')',
        'ORDER BY timestamp DESC',
        'LIMIT 50',
      ].join(' '),
      params: [since],
    };

    try {
      const response = await this.fetchJsonPost<RawSqlResponse>(
        `${this.baseUrl}/raw_sql`,
        body,
        RAW_SQL_TIMEOUT_MS,
      );
      return this.mapRawSqlRows(response.rows);
    } catch (err) {
      // Older Screenpipe versions don't have /raw_sql → fall back to client-side filter
      const isNotFound =
        err instanceof HttpError && err.status === 404;

      if (isNotFound) {
        this.log.warn('raw_sql endpoint not available, falling back to client-side error filter');
        return this.filterErrorsClientSide(hoursBack);
      }

      this.log.warn('queryErrorsFromOcr failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Perform a GET request and parse JSON, aborting after `timeoutMs`.
   */
  private async fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
    const controller = makeAbortController(timeoutMs);
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new HttpError(response.status, `GET ${url} → ${response.status}`);
    }
    return response.json() as Promise<T>;
  }

  /**
   * Perform a POST request with a JSON body and parse the JSON response.
   */
  private async fetchJsonPost<T>(
    url: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<T> {
    const controller = makeAbortController(timeoutMs);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new HttpError(response.status, `POST ${url} → ${response.status}`);
    }
    return response.json() as Promise<T>;
  }

  /**
   * Map raw_sql row objects to OcrEntry, filtering out ignored apps.
   */
  private mapRawSqlRows(rows: Record<string, unknown>[]): OcrEntry[] {
    const entries: OcrEntry[] = [];
    for (const row of rows) {
      const text = typeof row['text'] === 'string' ? row['text'] : '';
      const appName = typeof row['app_name'] === 'string' ? row['app_name'] : '';
      const windowName = typeof row['window_name'] === 'string' ? row['window_name'] : '';
      const timestamp = typeof row['timestamp'] === 'string' ? row['timestamp'] : '';

      if (text.trim().length < MIN_TEXT_LENGTH) continue;
      if (this.ignoreApps.has(appName)) continue;

      entries.push({ text, appName, windowName, timestamp });
    }
    return entries;
  }

  /**
   * Client-side fallback: fetch recent OCR and filter for error-like text.
   */
  private async filterErrorsClientSide(hoursBack: number): Promise<OcrEntry[]> {
    const minutesBack = hoursBack * 60;
    const all = await this.getRecentOcrText(minutesBack);
    const errorPatterns = [
      /Error/,
      /error:/i,
      /FAILED/,
      /Exception/,
      /npm ERR/,
      /SyntaxError/,
      /TypeError/,
      /Cannot find/,
      /ENOENT/,
    ];
    return all.filter((entry) =>
      errorPatterns.some((pattern) => pattern.test(entry.text)),
    );
  }
}

// ── Error class ───────────────────────────────────────────────────────────────

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

export default ScreenpipeClient;
