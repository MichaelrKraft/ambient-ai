/**
 * AmbientStore — all CRUD operations for the ambient intelligence database.
 *
 * All methods are synchronous (better-sqlite3's synchronous API).
 * JSON serialisation/deserialisation for array columns (apps_seen,
 * source_apps) is handled here; callers work with typed objects only.
 *
 * Daily token counting uses the date embedded in the state key so each
 * calendar day automatically starts at zero without any explicit reset.
 */

import crypto from 'crypto';
import { getDb } from './db.js';
import { createLogger } from '../shared/logger.js';
import { nowISO, hoursAgoISO, minutesAgoISO } from '../shared/time.js';

const log = createLogger('store');

// ---------------------------------------------------------------------------
// TypeScript interfaces
// ---------------------------------------------------------------------------

export interface ActivitySession {
  id: number;
  period_start: string;
  period_end: string;
  primary_app: string | null;
  summary: string | null;
  category: string | null;
  /** Deserialised from the TEXT JSON column. */
  apps_seen: string[] | null;
  token_cost: number;
}

export interface NewActivitySession {
  period_start: string;
  period_end: string;
  primary_app?: string;
  summary?: string;
  category?: string;
  apps_seen?: string[];
  token_cost?: number;
}

export interface KnowledgeItem {
  id: number;
  content: string;
  category: string | null;
  /** Deserialised from the TEXT JSON column. */
  source_apps: string[] | null;
  extracted_at: string;
  is_pii_flagged: boolean;
}

export interface NewKnowledgeItem {
  content: string;
  category?: string;
  source_apps?: string[];
  extracted_at?: string;
  is_pii_flagged?: boolean;
}

export interface ErrorEvent {
  id: number;
  error_text: string;
  app_name: string | null;
  first_seen: string;
  last_seen: string;
  occurrence_count: number;
  resolved_at: string | null;
  is_notified: boolean;
}

export interface Goal {
  id: string;
  title: string;
  description: string | null;
  created_at: string;
  target_date: string | null;
  status: 'active' | 'completed' | 'paused';
}

export interface NewGoal {
  id: string;
  title: string;
  description?: string;
  created_at?: string;
  target_date?: string;
  status?: 'active' | 'completed' | 'paused';
}

export interface GoalProgress {
  id: number;
  goal_id: string;
  timestamp: string;
  evidence: string | null;
  confidence: number | null;
}

export interface NewGoalProgress {
  goal_id: string;
  timestamp?: string;
  evidence?: string;
  confidence?: number;
}

export interface Notification {
  id: number;
  triggered_at: string;
  content: string;
  channel: string | null;
  feedback: string | null;
}

export interface NewNotification {
  triggered_at?: string;
  content: string;
  channel?: string;
}

export type TaskStatus = 'open' | 'done' | 'dismissed';

export interface Task {
  id: number;
  content: string;
  content_hash: string;
  /** Deserialised from the TEXT JSON column. */
  source_apps: string[] | null;
  /** Resolved absolute local date YYYY-MM-DD, or null. */
  due_date: string | null;
  status: TaskStatus;
  confidence: number | null;
  created_at: string;
  completed_at: string | null;
  is_pii_flagged: boolean;
}

export interface NewTask {
  content: string;
  source_apps?: string[];
  due_date?: string;
  confidence?: number;
  is_pii_flagged?: boolean;
}

// ---------------------------------------------------------------------------
// Raw row shapes returned by better-sqlite3 (before deserialisation)
// ---------------------------------------------------------------------------

interface RawActivitySession {
  id: number;
  period_start: string;
  period_end: string;
  primary_app: string | null;
  summary: string | null;
  category: string | null;
  apps_seen: string | null;
  token_cost: number;
}

interface RawKnowledgeItem {
  id: number;
  content: string;
  category: string | null;
  source_apps: string | null;
  extracted_at: string;
  is_pii_flagged: number;
}

interface RawErrorEvent {
  id: number;
  error_text: string;
  app_name: string | null;
  first_seen: string;
  last_seen: string;
  occurrence_count: number;
  resolved_at: string | null;
  is_notified: number;
}

interface RawGoal {
  id: string;
  title: string;
  description: string | null;
  created_at: string;
  target_date: string | null;
  status: string;
}

interface RawNotification {
  id: number;
  triggered_at: string;
  content: string;
  channel: string | null;
  feedback: string | null;
}

interface RawTask {
  id: number;
  content: string;
  content_hash: string;
  source_apps: string | null;
  due_date: string | null;
  status: string;
  confidence: number | null;
  created_at: string;
  completed_at: string | null;
  is_pii_flagged: number;
}

interface RawDaemonState {
  value: string | null;
}

// ---------------------------------------------------------------------------
// Deserialisation helpers
// ---------------------------------------------------------------------------

function parseJsonArray(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string');
    }
    log.warn('parseJsonArray: expected JSON array, got something else', { raw });
    return null;
  } catch {
    log.warn('parseJsonArray: invalid JSON', { raw });
    return null;
  }
}

function deserialiseActivity(row: RawActivitySession): ActivitySession {
  return {
    ...row,
    apps_seen: parseJsonArray(row.apps_seen),
  };
}

function deserialiseKnowledge(row: RawKnowledgeItem): KnowledgeItem {
  return {
    ...row,
    source_apps: parseJsonArray(row.source_apps),
    is_pii_flagged: row.is_pii_flagged !== 0,
  };
}

function deserialiseErrorEvent(row: RawErrorEvent): ErrorEvent {
  return {
    ...row,
    is_notified: row.is_notified !== 0,
  };
}

function deserialiseGoal(row: RawGoal): Goal {
  const status = row.status as Goal['status'];
  return { ...row, status };
}

function deserialiseTask(row: RawTask): Task {
  return {
    ...row,
    source_apps: parseJsonArray(row.source_apps),
    status: row.status as TaskStatus,
    is_pii_flagged: row.is_pii_flagged !== 0,
  };
}

/**
 * Normalises task content for dedup: lowercase, trim, collapse internal
 * whitespace. The SHA-256 of this string is stored as content_hash (UNIQUE),
 * so the same on-screen commitment seen across many cycles dedups to one row.
 */
function taskContentHash(content: string): string {
  const normalised = content.toLowerCase().trim().replace(/\s+/g, ' ');
  return crypto.createHash('sha256').update(normalised).digest('hex');
}

/**
 * Returns a YYYY-MM-DD string in LOCAL time for the given date (default: now).
 * Task due_dates and "overdue" comparisons are all local-date based, matching
 * dailyTokenKey() and the Obsidian exporter's local date ranges.
 */
export function localDateString(date: Date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Activity sessions
// ---------------------------------------------------------------------------

/**
 * Inserts a new activity session and returns the auto-incremented row id.
 */
export function insertActivitySession(session: NewActivitySession): number {
  const db = getDb();

  const result = db
    .prepare(
      `INSERT INTO activity_sessions
         (period_start, period_end, primary_app, summary, category, apps_seen, token_cost)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      session.period_start,
      session.period_end,
      session.primary_app ?? null,
      session.summary ?? null,
      session.category ?? null,
      session.apps_seen !== undefined ? JSON.stringify(session.apps_seen) : null,
      session.token_cost ?? 0,
    );

  const id = result.lastInsertRowid;
  log.debug(`Inserted activity session id=${String(id)}`);
  return Number(id);
}

/**
 * Returns activity sessions that started within the last `hoursBack` hours,
 * most recent first. Defaults to 100 rows if limit is not specified.
 */
export function getRecentActivity(
  hoursBack: number,
  limit: number = 100,
): ActivitySession[] {
  const db = getDb();
  const since = hoursAgoISO(hoursBack);

  const rows = db
    .prepare(
      `SELECT * FROM activity_sessions
       WHERE period_start >= ?
       ORDER BY period_start DESC
       LIMIT ?`,
    )
    .all(since, limit) as RawActivitySession[];

  return rows.map(deserialiseActivity);
}

// ---------------------------------------------------------------------------
// Knowledge items
// ---------------------------------------------------------------------------

/**
 * Inserts a knowledge item (triggers keep the FTS index in sync automatically).
 * Returns the auto-incremented row id.
 */
export function insertKnowledgeItem(item: NewKnowledgeItem): number {
  const db = getDb();

  const result = db
    .prepare(
      `INSERT INTO knowledge_items
         (content, category, source_apps, extracted_at, is_pii_flagged)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      item.content,
      item.category ?? null,
      item.source_apps !== undefined ? JSON.stringify(item.source_apps) : null,
      item.extracted_at ?? nowISO(),
      item.is_pii_flagged === true ? 1 : 0,
    );

  const id = result.lastInsertRowid;
  log.debug(`Inserted knowledge item id=${String(id)}`);
  return Number(id);
}

/**
 * Full-text search over knowledge items using the FTS5 index.
 * Returns up to `limit` results ordered by FTS relevance (bm25 rank).
 */
export function searchKnowledge(query: string, limit: number = 20): KnowledgeItem[] {
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT ki.*
       FROM knowledge_fts fts
       JOIN knowledge_items ki ON ki.id = fts.rowid
       WHERE knowledge_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(query, limit) as RawKnowledgeItem[];

  return rows.map(deserialiseKnowledge);
}

/**
 * Returns knowledge items extracted within the last `hoursBack` hours,
 * most recent first.
 */
export function getRecentKnowledge(
  hoursBack: number,
  limit: number = 50,
): KnowledgeItem[] {
  const db = getDb();
  const since = hoursAgoISO(hoursBack);

  const rows = db
    .prepare(
      `SELECT * FROM knowledge_items
       WHERE extracted_at >= ?
       ORDER BY extracted_at DESC
       LIMIT ?`,
    )
    .all(since, limit) as RawKnowledgeItem[];

  return rows.map(deserialiseKnowledge);
}

// ---------------------------------------------------------------------------
// Error events
// ---------------------------------------------------------------------------

/**
 * Upserts an error event.
 *
 * If the same error_text has been seen in the last 24 hours, increments
 * occurrence_count and updates last_seen. Otherwise inserts a new record.
 *
 * Grouping window is 24 hours so that a recurring compile error that fires
 * dozens of times per day appears as a single unresolved item.
 */
export function upsertErrorEvent(errorText: string, appName: string): void {
  const db = getDb();
  const since = hoursAgoISO(24);
  const now = nowISO();

  const existing = db
    .prepare(
      `SELECT id FROM error_events
       WHERE error_text = ? AND last_seen > ? AND resolved_at IS NULL
       LIMIT 1`,
    )
    .get(errorText, since) as { id: number } | undefined;

  if (existing !== undefined) {
    db
      .prepare(
        `UPDATE error_events
         SET occurrence_count = occurrence_count + 1,
             last_seen = ?,
             app_name = ?
         WHERE id = ?`,
      )
      .run(now, appName, existing.id);
    log.debug(`Incremented error_event id=${existing.id}`);
  } else {
    const result = db
      .prepare(
        `INSERT INTO error_events
           (error_text, app_name, first_seen, last_seen, occurrence_count, is_notified)
         VALUES (?, ?, ?, ?, 1, 0)`,
      )
      .run(errorText, appName, now, now);
    log.debug(`Inserted error_event id=${String(result.lastInsertRowid)}`);
  }
}

/**
 * Returns unresolved error events whose first_seen is older than
 * `olderThanMinutes` minutes and that have not yet triggered a notification.
 *
 * The age filter avoids alerting on errors that just appeared and may
 * resolve themselves within the next polling cycle.
 */
export function getUnresolvedErrors(olderThanMinutes: number): ErrorEvent[] {
  const db = getDb();
  const cutoff = minutesAgoISO(olderThanMinutes);

  const rows = db
    .prepare(
      `SELECT * FROM error_events
       WHERE first_seen < ?
         AND resolved_at IS NULL
         AND is_notified = 0
       ORDER BY first_seen ASC`,
    )
    .all(cutoff) as RawErrorEvent[];

  return rows.map(deserialiseErrorEvent);
}

/** Marks an error event as resolved (sets resolved_at to now). */
export function markErrorResolved(id: number): void {
  const db = getDb();
  db.prepare(`UPDATE error_events SET resolved_at = ? WHERE id = ?`).run(nowISO(), id);
  log.debug(`Marked error_event id=${id} resolved`);
}

/** Marks an error event as notified so it is excluded from future alerts. */
export function markErrorNotified(id: number): void {
  const db = getDb();
  db.prepare(`UPDATE error_events SET is_notified = 1 WHERE id = ?`).run(id);
  log.debug(`Marked error_event id=${id} notified`);
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

/** Inserts a new goal. The caller must supply a UUID for the id field. */
export function insertGoal(goal: NewGoal): void {
  const db = getDb();
  db
    .prepare(
      `INSERT INTO goals (id, title, description, created_at, target_date, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      goal.id,
      goal.title,
      goal.description ?? null,
      goal.created_at ?? nowISO(),
      goal.target_date ?? null,
      goal.status ?? 'active',
    );
  log.debug(`Inserted goal id=${goal.id}`);
}

/** Returns all goals with status='active', ordered by creation date ascending. */
export function getActiveGoals(): Goal[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM goals WHERE status = 'active' ORDER BY created_at ASC`,
    )
    .all() as RawGoal[];
  return rows.map(deserialiseGoal);
}

/**
 * Returns active goals whose target_date is within `withinDays` days AND that
 * have recorded no goal_progress in the last `staleDays` days — i.e. goals
 * worth nudging the user about. Soonest deadline first.
 */
export function getGoalsNeedingNudge(
  withinDays: number = 7,
  staleDays: number = 3,
): Goal[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT g.* FROM goals g
       WHERE g.status = 'active'
         AND g.target_date IS NOT NULL
         AND date(g.target_date) <= date('now', '+' || ? || ' days')
         AND NOT EXISTS (
           SELECT 1 FROM goal_progress gp
           WHERE gp.goal_id = g.id
             AND gp.timestamp > datetime('now', '-' || ? || ' days')
         )
       ORDER BY date(g.target_date) ASC`,
    )
    .all(withinDays, staleDays) as RawGoal[];
  return rows.map(deserialiseGoal);
}

// ---------------------------------------------------------------------------
// Goal progress
// ---------------------------------------------------------------------------

/** Records a piece of evidence that the user made progress toward a goal. */
export function insertGoalProgress(progress: NewGoalProgress): void {
  const db = getDb();
  db
    .prepare(
      `INSERT INTO goal_progress (goal_id, timestamp, evidence, confidence)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      progress.goal_id,
      progress.timestamp ?? nowISO(),
      progress.evidence ?? null,
      progress.confidence ?? null,
    );
  log.debug(`Inserted goal_progress for goal_id=${progress.goal_id}`);
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/** Records a notification that was sent. */
export function insertNotification(notif: NewNotification): void {
  const db = getDb();
  db
    .prepare(
      `INSERT INTO notifications (triggered_at, content, channel)
       VALUES (?, ?, ?)`,
    )
    .run(notif.triggered_at ?? nowISO(), notif.content, notif.channel ?? null);
  log.debug('Inserted notification');
}

/**
 * Returns notifications sent within the last `hoursBack` hours,
 * most recent first.
 */
export function getRecentNotifications(hoursBack: number): Notification[] {
  const db = getDb();
  const since = hoursAgoISO(hoursBack);

  const rows = db
    .prepare(
      `SELECT * FROM notifications
       WHERE triggered_at >= ?
       ORDER BY triggered_at DESC`,
    )
    .all(since) as RawNotification[];

  return rows;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/**
 * Inserts an auto-captured task, deduping on content_hash via INSERT OR IGNORE.
 *
 * Returns the new row id, or null when the task already existed (the same
 * commitment seen on a previous cycle) and the insert was ignored.
 */
export function insertTask(task: NewTask): number | null {
  const db = getDb();
  const hash = taskContentHash(task.content);

  const result = db
    .prepare(
      `INSERT OR IGNORE INTO tasks
         (content, content_hash, source_apps, due_date, status, confidence, created_at, is_pii_flagged)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`,
    )
    .run(
      task.content,
      hash,
      task.source_apps !== undefined ? JSON.stringify(task.source_apps) : null,
      task.due_date ?? null,
      task.confidence ?? null,
      nowISO(),
      task.is_pii_flagged === true ? 1 : 0,
    );

  if (result.changes === 0) {
    log.debug('Task already exists (dedup) — insert ignored');
    return null;
  }

  const id = Number(result.lastInsertRowid);
  log.debug(`Inserted task id=${id}`);
  return id;
}

/** Returns all open tasks, oldest first. */
export function getOpenTasks(limit: number = 100): Task[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM tasks WHERE status = 'open' ORDER BY created_at ASC LIMIT ?`,
    )
    .all(limit) as RawTask[];
  return rows.map(deserialiseTask);
}

/**
 * Returns open tasks whose due_date is strictly before today (local date),
 * oldest due first. Tasks with a NULL due_date are never overdue.
 */
export function getOverdueTasks(): Task[] {
  const db = getDb();
  const today = localDateString();
  const rows = db
    .prepare(
      `SELECT * FROM tasks
       WHERE status = 'open' AND due_date IS NOT NULL AND due_date < ?
       ORDER BY due_date ASC`,
    )
    .all(today) as RawTask[];
  return rows.map(deserialiseTask);
}

/**
 * Returns open tasks due within the next `withinHours` hours (by local date),
 * including any already due today. Used for "tomorrow's priorities".
 */
export function getUpcomingTasks(withinHours: number = 48): Task[] {
  const db = getDb();
  const today = localDateString();
  const until = localDateString(new Date(Date.now() + withinHours * 3_600_000));
  const rows = db
    .prepare(
      `SELECT * FROM tasks
       WHERE status = 'open' AND due_date IS NOT NULL
         AND due_date >= ? AND due_date <= ?
       ORDER BY due_date ASC`,
    )
    .all(today, until) as RawTask[];
  return rows.map(deserialiseTask);
}

/**
 * Returns tasks created OR completed within [startISO, endISO).
 * Used by the daily export to show today's captured + completed tasks.
 */
export function getTasksForDateRange(startISO: string, endISO: string): Task[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM tasks
       WHERE (created_at >= ? AND created_at < ?)
          OR (completed_at >= ? AND completed_at < ?)
       ORDER BY created_at ASC`,
    )
    .all(startISO, endISO, startISO, endISO) as RawTask[];
  return rows.map(deserialiseTask);
}

/** Marks a task done (sets status + completed_at). Returns true if a row changed. */
export function markTaskDone(id: number): boolean {
  const db = getDb();
  const result = db
    .prepare(`UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ? AND status = 'open'`)
    .run(nowISO(), id);
  log.debug(`markTaskDone id=${id} changed=${result.changes}`);
  return result.changes > 0;
}

/**
 * Dismisses open tasks created more than `olderThanDays` days ago so stale
 * commitments don't accumulate and flood overdue alerts forever.
 * Returns the number of tasks dismissed.
 */
export function autoDismissStaleTasks(olderThanDays: number = 14): number {
  const db = getDb();
  const cutoff = hoursAgoISO(olderThanDays * 24);
  const result = db
    .prepare(
      `UPDATE tasks SET status = 'dismissed'
       WHERE status = 'open' AND created_at < ?`,
    )
    .run(cutoff);
  if (result.changes > 0) {
    log.info(`Auto-dismissed ${result.changes} stale task(s)`);
  }
  return result.changes;
}

// ---------------------------------------------------------------------------
// Daemon state (key-value)
// ---------------------------------------------------------------------------

/** Returns the stored string value for the given key, or null if absent. */
export function getDaemonState(key: string): string | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT value FROM daemon_state WHERE key = ?`)
    .get(key) as RawDaemonState | undefined;
  return row?.value ?? null;
}

/** Upserts a key-value pair in daemon_state, updating updated_at. */
export function setDaemonState(key: string, value: string): void {
  const db = getDb();
  db
    .prepare(
      `INSERT INTO daemon_state (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, nowISO());
}

// ---------------------------------------------------------------------------
// Daily token tracking
//
// The key embeds today's date in local time, e.g. 'daily_tokens_2026-03-04'.
// Because each calendar day gets a unique key there is no need for an explicit
// reset: yesterday's key is simply never read or written again.
// ---------------------------------------------------------------------------

function dailyTokenKey(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `daily_tokens_${yyyy}-${mm}-${dd}`;
}

/** Returns today's cumulative Claude token count, defaulting to 0. */
export function getDailyTokenCount(): number {
  const raw = getDaemonState(dailyTokenKey());
  if (raw === null) return 0;
  const parsed = parseInt(raw, 10);
  return isNaN(parsed) ? 0 : parsed;
}

/**
 * Atomically adds `tokens` to today's running total.
 * Returns the new total.
 */
export function addDailyTokenCount(tokens: number): number {
  const key = dailyTokenKey();
  const db = getDb();
  const now = nowISO();

  // Use a single UPDATE … RETURNING or simulate atomicity with a transaction.
  const increment = db.transaction((): number => {
    const row = db
      .prepare(`SELECT value FROM daemon_state WHERE key = ?`)
      .get(key) as RawDaemonState | undefined;

    const current = row?.value !== undefined && row.value !== null
      ? (parseInt(row.value, 10) || 0)
      : 0;
    const updated = current + tokens;

    db
      .prepare(
        `INSERT INTO daemon_state (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, String(updated), now);

    return updated;
  });

  const newTotal = increment();
  log.debug(`Daily tokens: +${tokens} → ${newTotal}`);
  return newTotal;
}

/**
 * Resets today's token counter to zero.
 * Normally not needed (the key rotates daily) but exposed for CLI tooling.
 */
export function resetDailyTokenCount(): void {
  setDaemonState(dailyTokenKey(), '0');
  log.info('Daily token count reset to 0');
}
