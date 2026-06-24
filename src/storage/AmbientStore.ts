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
  /** Goal this session most advanced (set by the analyzer), or null. */
  aligned_goal_id?: string | null;
}

export interface NewActivitySession {
  period_start: string;
  period_end: string;
  primary_app?: string;
  summary?: string;
  category?: string;
  apps_seen?: string[];
  token_cost?: number;
  aligned_goal_id?: string;
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
  /** 1 = priority goal counted in the Focus Score; 2 = normal. */
  tier: number;
}

export interface NewGoal {
  id: string;
  title: string;
  description?: string;
  created_at?: string;
  target_date?: string;
  status?: 'active' | 'completed' | 'paused';
  tier?: number;
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
  /** 'auto' (screen-extracted) | 'manual' (typed by the user). */
  source: string;
  /** Optional link to a goal; completing the task logs progress on it. */
  goal_id: string | null;
  /** 0 = suggestions inbox (awaiting triage); 1 = a real list task. */
  accepted: boolean;
}

export interface NewTask {
  content: string;
  source_apps?: string[];
  due_date?: string;
  confidence?: number;
  is_pii_flagged?: boolean;
  source?: string;
  goal_id?: string;
  /** Defaults to 1 (real task); auto-capture passes 0 to route to the inbox. */
  accepted?: boolean;
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
  aligned_goal_id: string | null;
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
  tier: number;
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
  source: string;
  goal_id: string | null;
  accepted: number;
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
    accepted: row.accepted !== 0,
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
         (period_start, period_end, primary_app, summary, category, apps_seen, token_cost, aligned_goal_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      session.period_start,
      session.period_end,
      session.primary_app ?? null,
      session.summary ?? null,
      session.category ?? null,
      session.apps_seen !== undefined ? JSON.stringify(session.apps_seen) : null,
      session.token_cost ?? 0,
      session.aligned_goal_id ?? null,
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

/**
 * One row of the daily time breakdown: a label (category or app name) and the
 * total minutes of activity attributed to it within the window.
 */
export interface TimeBreakdownRow {
  label: string;
  minutes: number;
}

export interface TimeBreakdown {
  totalMinutes: number;
  byCategory: TimeBreakdownRow[];
  byApp: TimeBreakdownRow[];
}

interface RawBreakdownRow {
  label: string | null;
  minutes: number | null;
}

/**
 * Aggregates activity-session durations over the last `hoursBack` hours into a
 * time breakdown grouped by category ("tasks") and by primary_app ("websites").
 *
 * Duration per session = period_end - period_start, summed via julianday()
 * (which parses the stored ISO timestamps). Rows are returned largest-first.
 * Screenpipe captures app-level activity only, so the "app" breakdown is the
 * closest available proxy for time-per-website.
 */
export function getTimeBreakdown(hoursBack: number): TimeBreakdown {
  const db = getDb();
  const since = hoursAgoISO(hoursBack);

  const durationExpr =
    `(julianday(period_end) - julianday(period_start)) * 24 * 60`;

  const byCategory = (
    db
      .prepare(
        `SELECT COALESCE(NULLIF(TRIM(category), ''), 'other') AS label,
                SUM(${durationExpr}) AS minutes
         FROM activity_sessions
         WHERE period_start >= ?
         GROUP BY label
         ORDER BY minutes DESC`,
      )
      .all(since) as RawBreakdownRow[]
  ).map(normaliseBreakdownRow);

  const byApp = (
    db
      .prepare(
        `SELECT COALESCE(NULLIF(TRIM(primary_app), ''), 'Unknown') AS label,
                SUM(${durationExpr}) AS minutes
         FROM activity_sessions
         WHERE period_start >= ?
         GROUP BY label
         ORDER BY minutes DESC`,
      )
      .all(since) as RawBreakdownRow[]
  ).map(normaliseBreakdownRow);

  const totalMinutes = byCategory.reduce((sum, r) => sum + r.minutes, 0);

  return { totalMinutes: Math.round(totalMinutes), byCategory, byApp };
}

function normaliseBreakdownRow(row: RawBreakdownRow): TimeBreakdownRow {
  return {
    label: row.label ?? 'Unknown',
    minutes: Math.round(row.minutes ?? 0),
  };
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
      `INSERT INTO goals (id, title, description, created_at, target_date, status, tier)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      goal.id,
      goal.title,
      goal.description ?? null,
      goal.created_at ?? nowISO(),
      goal.target_date ?? null,
      goal.status ?? 'active',
      goal.tier ?? 2,
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
// Goals & Accountability — daily intentions, weekly focus, scorecard
// ---------------------------------------------------------------------------

export interface IntentionItem {
  text: string;
  goal_id?: string | null;
  done?: boolean;
}

/** Upserts today's (or any date's) top-3 intentions. */
export function setDailyIntentions(date: string, items: IntentionItem[]): void {
  getDb()
    .prepare(
      `INSERT INTO daily_intentions (date, items, set_at)
       VALUES (?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET items = excluded.items, set_at = excluded.set_at`,
    )
    .run(date, JSON.stringify(items), nowISO());
}

export function getDailyIntentions(date: string): IntentionItem[] {
  const row = getDb()
    .prepare(`SELECT items FROM daily_intentions WHERE date = ?`)
    .get(date) as { items: string } | undefined;
  if (!row) return [];
  try {
    const parsed: unknown = JSON.parse(row.items);
    return Array.isArray(parsed) ? (parsed as IntentionItem[]) : [];
  } catch {
    return [];
  }
}

export function setIntentionsReviewed(date: string): void {
  getDb().prepare(`UPDATE daily_intentions SET reviewed_at = ? WHERE date = ?`).run(nowISO(), date);
}

export interface WeeklyFocus {
  week_start_date: string;
  title: string | null;
  notes: string | null;
  goal_ids: string[];
  updated_at: string | null;
}

interface RawWeeklyFocus {
  week_start_date: string;
  title: string | null;
  notes: string | null;
  goal_ids: string | null;
  updated_at: string | null;
}

/** Monday (local) of the week containing `date`, as YYYY-MM-DD. */
export function mondayOf(date: Date = new Date()): string {
  const d = new Date(date);
  const offset = (d.getDay() + 6) % 7; // days since Monday (0 = Monday)
  d.setDate(d.getDate() - offset);
  return localDateString(d);
}

export function setWeeklyFocus(
  weekStart: string,
  title: string,
  notes: string,
  goalIds: string[],
): void {
  getDb()
    .prepare(
      `INSERT INTO weekly_focus (week_start_date, title, notes, goal_ids, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(week_start_date) DO UPDATE SET
         title = excluded.title, notes = excluded.notes,
         goal_ids = excluded.goal_ids, updated_at = excluded.updated_at`,
    )
    .run(weekStart, title, notes, JSON.stringify(goalIds), nowISO());
}

/** Returns the focus row for the week containing `date` (Monday-keyed), or null. */
export function getCurrentWeeklyFocus(date: Date = new Date()): WeeklyFocus | null {
  const row = getDb()
    .prepare(`SELECT * FROM weekly_focus WHERE week_start_date = ?`)
    .get(mondayOf(date)) as RawWeeklyFocus | undefined;
  if (!row) return null;
  return { ...row, goal_ids: parseJsonArray(row.goal_ids) ?? [] };
}

/** Sets a goal's tier (1 = priority counted in the Focus Score). */
export function setGoalTier(goalId: string, tier: number): void {
  getDb().prepare(`UPDATE goals SET tier = ? WHERE id = ?`).run(tier, goalId);
}

/**
 * Marks a goal completed — it drops out of the active list (getActiveGoals
 * filters status='active') but the record is kept. Returns true if changed.
 */
export function completeGoal(goalId: string): boolean {
  const r = getDb()
    .prepare(`UPDATE goals SET status = 'completed' WHERE id = ? AND status = 'active'`)
    .run(goalId);
  return r.changes > 0;
}

/** Permanently deletes a goal and its progress rows (for ones added by mistake). */
export function deleteGoal(goalId: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM goal_progress WHERE goal_id = ?`).run(goalId);
  db.prepare(`DELETE FROM goals WHERE id = ?`).run(goalId);
}

export interface GoalTimeProgress {
  minutes: number;
  lastEvidenceAt: string | null;
  lastEvidence: string | null;
  progressCount: number;
}

/** Time-on-goal (from aligned sessions) + recent goal_progress, over `days`. */
export function getGoalTimeAndProgress(goalId: string, days: number = 7): GoalTimeProgress {
  const db = getDb();
  const since = hoursAgoISO(days * 24);
  const dur = `(julianday(period_end) - julianday(period_start)) * 24 * 60`;
  const t = db
    .prepare(
      `SELECT COALESCE(SUM(${dur}),0) AS minutes FROM activity_sessions
       WHERE aligned_goal_id = ? AND period_start >= ?`,
    )
    .get(goalId, since) as { minutes: number };
  const p = db
    .prepare(
      `SELECT timestamp, evidence FROM goal_progress
       WHERE goal_id = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT 1`,
    )
    .get(goalId, since) as { timestamp: string; evidence: string | null } | undefined;
  const c = db
    .prepare(`SELECT COUNT(*) AS n FROM goal_progress WHERE goal_id = ? AND timestamp >= ?`)
    .get(goalId, since) as { n: number };
  return {
    minutes: Math.round(t.minutes || 0),
    lastEvidenceAt: p?.timestamp ?? null,
    lastEvidence: p?.evidence ?? null,
    progressCount: c.n,
  };
}

export interface Scorecard {
  date: string;
  focus_score: number;
  tier1_minutes: number;
  total_minutes: number;
  aligned: number;
  drifting: number;
  neglected: number;
  computed_at: string | null;
}

export function upsertDailyScorecard(s: Scorecard): void {
  getDb()
    .prepare(
      `INSERT INTO daily_scorecard
         (date, focus_score, tier1_minutes, total_minutes, aligned, drifting, neglected, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         focus_score = excluded.focus_score, tier1_minutes = excluded.tier1_minutes,
         total_minutes = excluded.total_minutes, aligned = excluded.aligned,
         drifting = excluded.drifting, neglected = excluded.neglected,
         computed_at = excluded.computed_at`,
    )
    .run(
      s.date,
      s.focus_score,
      s.tier1_minutes,
      s.total_minutes,
      s.aligned,
      s.drifting,
      s.neglected,
      s.computed_at ?? nowISO(),
    );
}

export function getScorecard(date: string): Scorecard | null {
  const row = getDb().prepare(`SELECT * FROM daily_scorecard WHERE date = ?`).get(date) as
    | Scorecard
    | undefined;
  return row ?? null;
}

export function getScorecardTrend(days: number = 7): Scorecard[] {
  return getDb()
    .prepare(`SELECT * FROM daily_scorecard ORDER BY date DESC LIMIT ?`)
    .all(days) as Scorecard[];
}

/** Tier-1-aligned minutes vs all tracked minutes for a local date. */
export function getDailyAlignmentMinutes(date: string): { tier1: number; total: number } {
  const db = getDb();
  const dur = `(julianday(period_end) - julianday(period_start)) * 24 * 60`;
  // Sessions are stored in UTC; convert to local before taking the date so
  // evening work (already "tomorrow" in UTC) counts toward the local day.
  const total = db
    .prepare(
      `SELECT COALESCE(SUM(${dur}),0) AS m FROM activity_sessions
       WHERE date(period_start, 'localtime') = date(?)`,
    )
    .get(date) as { m: number };
  const tier1 = db
    .prepare(
      `SELECT COALESCE(SUM(${dur}),0) AS m FROM activity_sessions a
       JOIN goals g ON g.id = a.aligned_goal_id AND g.tier = 1
       WHERE date(a.period_start, 'localtime') = date(?)`,
    )
    .get(date) as { m: number };
  return { tier1: Math.round(tier1.m || 0), total: Math.round(total.m || 0) };
}

/** Minutes on a specific local date attributed (aligned) to a single goal. */
export function getGoalAlignedMinutesForDate(goalId: string, date: string): number {
  const db = getDb();
  const dur = `(julianday(period_end) - julianday(period_start)) * 24 * 60`;
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(${dur}),0) AS m FROM activity_sessions
       WHERE aligned_goal_id = ? AND date(period_start, 'localtime') = date(?)`,
    )
    .get(goalId, date) as { m: number };
  return Math.round(r.m || 0);
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
         (content, content_hash, source_apps, due_date, status, confidence, created_at, is_pii_flagged, source, goal_id, accepted)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      task.content,
      hash,
      task.source_apps !== undefined ? JSON.stringify(task.source_apps) : null,
      task.due_date ?? null,
      task.confidence ?? null,
      nowISO(),
      task.is_pii_flagged === true ? 1 : 0,
      task.source ?? 'auto',
      task.goal_id ?? null,
      task.accepted === false ? 0 : 1,
    );

  if (result.changes === 0) {
    log.debug('Task already exists (dedup) — insert ignored');
    return null;
  }

  const id = Number(result.lastInsertRowid);
  log.debug(`Inserted task id=${id}`);
  return id;
}

/**
 * Inserts a user-typed to-do. Unlike insertTask (auto-capture), this never
 * dedups — manual to-dos may legitimately repeat — so it uses a unique
 * content_hash. source='manual', accepted=1 (a real list task).
 */
export function insertManualTask(task: {
  content: string;
  due_date?: string;
  goal_id?: string;
}): number {
  const db = getDb();
  const hash = `manual:${crypto.randomUUID()}`;
  const result = db
    .prepare(
      `INSERT INTO tasks
         (content, content_hash, source_apps, due_date, status, confidence, created_at, is_pii_flagged, source, goal_id, accepted)
       VALUES (?, ?, NULL, ?, 'open', NULL, ?, 0, 'manual', ?, 1)`,
    )
    .run(task.content, hash, task.due_date ?? null, nowISO(), task.goal_id ?? null);
  return Number(result.lastInsertRowid);
}

/** Returns all accepted open list tasks, oldest first (excludes the inbox). */
export function getOpenTasks(limit: number = 100): Task[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM tasks WHERE status = 'open' AND accepted = 1 ORDER BY created_at ASC LIMIT ?`,
    )
    .all(limit) as RawTask[];
  return rows.map(deserialiseTask);
}

/** Auto-captured tasks awaiting triage in the "Ambient noticed" inbox. */
export function getSuggestedTasks(limit: number = 50): Task[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM tasks
       WHERE status = 'open' AND accepted = 0 AND source = 'auto'
       ORDER BY created_at DESC LIMIT ?`,
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
       WHERE status = 'open' AND accepted = 1 AND due_date IS NOT NULL AND due_date < ?
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
       WHERE status = 'open' AND accepted = 1 AND due_date IS NOT NULL
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

/** Returns a single task by id, or null. */
export function getTaskById(id: number): Task | null {
  const row = getDb().prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as RawTask | undefined;
  return row ? deserialiseTask(row) : null;
}

/** Re-opens a done/dismissed task (clears completed_at). */
export function reopenTask(id: number): boolean {
  const r = getDb()
    .prepare(`UPDATE tasks SET status = 'open', completed_at = NULL WHERE id = ?`)
    .run(id);
  return r.changes > 0;
}

/** Accepts a suggestion (moves it from the inbox into the real list). */
export function acceptTask(id: number): boolean {
  const r = getDb().prepare(`UPDATE tasks SET accepted = 1 WHERE id = ?`).run(id);
  return r.changes > 0;
}

/** Dismisses a task (suggestion or otherwise). */
export function dismissTask(id: number): boolean {
  const r = getDb().prepare(`UPDATE tasks SET status = 'dismissed' WHERE id = ?`).run(id);
  return r.changes > 0;
}

/** Permanently deletes a task. */
export function deleteTask(id: number): void {
  getDb().prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
}

/** Edits a task's content / due date / goal link. Only provided fields change. */
export function updateTask(
  id: number,
  fields: { content?: string; due_date?: string | null; goal_id?: string | null },
): void {
  const sets: string[] = [];
  const vals: Array<string | null> = [];
  if (fields.content !== undefined) {
    sets.push('content = ?');
    vals.push(fields.content);
  }
  if (fields.due_date !== undefined) {
    sets.push('due_date = ?');
    vals.push(fields.due_date);
  }
  if (fields.goal_id !== undefined) {
    sets.push('goal_id = ?');
    vals.push(fields.goal_id);
  }
  if (sets.length === 0) return;
  vals.push(String(id));
  getDb()
    .prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`)
    .run(...vals);
}

/** Tasks completed on a given local date (for the "Done today" section). */
export function getTasksDoneOnDate(date: string): Task[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM tasks
       WHERE status = 'done' AND completed_at IS NOT NULL
         AND date(completed_at, 'localtime') = date(?)
       ORDER BY completed_at DESC`,
    )
    .all(date) as RawTask[];
  return rows.map(deserialiseTask);
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
