/**
 * ObsidianExporter — Export Ambient activity data to Obsidian daily notes.
 *
 * Reads today's activity sessions and knowledge items from the Ambient database
 * and writes a formatted Markdown daily note to the Obsidian vault.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { getDb } from '../storage/db.js';
import { createLogger } from '../shared/logger.js';
import { loadConfig } from '../config/index.js';
import { AtomicLinker } from './AtomicLinker.js';
import {
  getTasksForDateRange,
  getOpenTasks,
  getOverdueTasks,
  getUpcomingTasks,
  getUnresolvedErrors,
  autoDismissStaleTasks,
  type ActivitySession,
  type KnowledgeItem,
  type Task,
  type ErrorEvent,
} from '../storage/AmbientStore.js';

/** The task/meeting data threaded into the daily note's "Tasks & Follow-ups". */
interface DailyTaskData {
  completedToday: Task[];
  openTasks: Task[];
  overdue: Task[];
  upcoming: Task[];
  unresolvedErrors: ErrorEvent[];
}

const log = createLogger('obsidian');

/**
 * Google Drive's file-provider sync briefly locks vault files mid-sync,
 * surfacing as EDEADLK on writeFileSync. Retry with backoff instead of
 * failing the whole export cycle.
 */
function writeFileWithRetry(filePath: string, content: string, attempts = 4): void {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.writeFileSync(filePath, content, 'utf8');
      return;
    } catch (err) {
      const isDeadlock = (err as NodeJS.ErrnoException)?.code === 'EDEADLK';
      if (!isDeadlock || i === attempts - 1) throw err;
      const delayMs = 500 * 2 ** i;
      log.warn(`Write locked by sync provider, retrying in ${delayMs}ms (attempt ${i + 1}/${attempts})`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ObsidianConfig {
  vaultPath: string;
  dailyNotesFolder: string;
  dateFormat: string; // e.g., 'YYYY-MM-DD'
}

const DEFAULT_CONFIG: ObsidianConfig = {
  vaultPath: path.join(os.homedir(), 'Documents/Obsidian Notes'),
  dailyNotesFolder: 'raw/daily',
  dateFormat: 'YYYY-MM-DD',
};

function getConfig(): ObsidianConfig {
  // Priority: ENV var > DEFAULT_CONFIG (which now points to Documents)
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH ?? DEFAULT_CONFIG.vaultPath;
  return {
    ...DEFAULT_CONFIG,
    vaultPath,
  };
}

// ---------------------------------------------------------------------------
// Date utilities
// ---------------------------------------------------------------------------

function formatDate(date: Date, format: string): string {
  const yyyy = date.getFullYear().toString();
  const mm = (date.getMonth() + 1).toString().padStart(2, '0');
  const dd = date.getDate().toString().padStart(2, '0');

  return format
    .replace('YYYY', yyyy)
    .replace('MM', mm)
    .replace('DD', dd);
}

function getTodayDateRange(): { start: string; end: string } {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  return {
    start: startOfDay.toISOString(),
    end: endOfDay.toISOString(),
  };
}

function formatTimeFromISO(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function formatDuration(startISO: string, endISO: string): string {
  const start = new Date(startISO);
  const end = new Date(endISO);
  const diffMs = end.getTime() - start.getTime();
  const diffMins = Math.round(diffMs / 60000);

  if (diffMins < 60) {
    return `${diffMins}m`;
  }
  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

// ---------------------------------------------------------------------------
// Database queries for date range
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

function parseJsonArray(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string');
    }
    return null;
  } catch {
    return null;
  }
}

function getActivityForDateRange(start: string, end: string): ActivitySession[] {
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT * FROM activity_sessions
       WHERE period_start >= ? AND period_start <= ?
       ORDER BY period_start ASC`,
    )
    .all(start, end) as RawActivitySession[];

  return rows.map((row) => ({
    ...row,
    apps_seen: parseJsonArray(row.apps_seen),
  }));
}

function getKnowledgeForDateRange(start: string, end: string): KnowledgeItem[] {
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT * FROM knowledge_items
       WHERE extracted_at >= ? AND extracted_at <= ?
       ORDER BY extracted_at ASC`,
    )
    .all(start, end) as RawKnowledgeItem[];

  return rows.map((row) => ({
    ...row,
    source_apps: parseJsonArray(row.source_apps),
    is_pii_flagged: row.is_pii_flagged !== 0,
  }));
}

// ---------------------------------------------------------------------------
// Markdown formatting
// ---------------------------------------------------------------------------

function formatActivityTimeline(
  activities: ActivitySession[],
  linker: AtomicLinker | null = null
): string {
  if (activities.length === 0) {
    return '_No activity recorded yet today._';
  }

  const lines: string[] = [];

  for (const activity of activities) {
    const startTime = formatTimeFromISO(activity.period_start);
    const duration = formatDuration(activity.period_start, activity.period_end);

    // Apply atomic linking to app and category
    const app = linker
      ? linker.linkApp(activity.primary_app)
      : (activity.primary_app ?? 'Unknown');

    const category = linker && activity.category
      ? ` ${linker.linkCategory(activity.category)}`
      : (activity.category ? ` [${activity.category}]` : '');

    lines.push(`- **${startTime}** (${duration}) — ${app}${category}`);

    if (activity.summary) {
      // Indent the summary under the timeline entry
      const summaryLines = activity.summary.split('\n').filter((l) => l.trim());
      for (const summaryLine of summaryLines) {
        // Apply concept linking for aggressive mode
        const linkedLine = linker
          ? linker.linkConcepts(summaryLine.trim())
          : summaryLine.trim();
        lines.push(`  - ${linkedLine}`);
      }
    }

    if (activity.apps_seen && activity.apps_seen.length > 1) {
      const otherApps = activity.apps_seen.filter((a) => a !== activity.primary_app);
      if (otherApps.length > 0) {
        // Link other apps too
        const linkedApps = linker
          ? otherApps.map((a) => linker.linkApp(a)).join(', ')
          : otherApps.join(', ');
        lines.push(`  - Also used: ${linkedApps}`);
      }
    }
  }

  return lines.join('\n');
}

function formatKnowledgeInsights(
  knowledge: KnowledgeItem[],
  linker: AtomicLinker | null = null
): string {
  if (knowledge.length === 0) {
    return '_No insights captured today._';
  }

  const lines: string[] = [];

  for (const item of knowledge) {
    // Link the category if linker is active
    const category = item.category
      ? (linker ? `**${linker.linkCategory(item.category)}**` : `**${item.category}**`)
      : 'Insight';
    const time = formatTimeFromISO(item.extracted_at);

    // Link source apps
    const apps = item.source_apps
      ? (linker
          ? item.source_apps.map((a) => linker.linkApp(a)).join(', ')
          : item.source_apps.join(', '))
      : '';

    lines.push(`### ${category} (${time})`);
    if (apps) {
      lines.push(`_From: ${apps}_`);
    }
    lines.push('');

    // Link concepts in content for aggressive mode
    const content = linker ? linker.linkConcepts(item.content) : item.content;
    lines.push(content);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Renders the "Tasks & Follow-ups" block — Air Jelly's structured brief:
 * Completed today / Open threads (open + overdue + unresolved errors) /
 * Tomorrow's priorities (tasks due within 48h). Returns an empty string when
 * there is nothing in any bucket, so the section is omitted entirely.
 */
function formatTasksSection(data: DailyTaskData): string {
  const { completedToday, openTasks, overdue, upcoming, unresolvedErrors } = data;
  if (
    completedToday.length === 0 &&
    openTasks.length === 0 &&
    unresolvedErrors.length === 0
  ) {
    return '';
  }

  const overdueIds = new Set(overdue.map((t) => t.id));
  const lines: string[] = ['## Tasks & Follow-ups', ''];

  // Completed today
  lines.push('### Completed');
  if (completedToday.length === 0) {
    lines.push('_Nothing marked done today._');
  } else {
    for (const t of completedToday) lines.push(`- [x] ${t.content}`);
  }
  lines.push('');

  // Open threads: open tasks (overdue flagged) + unresolved errors
  lines.push('### Open threads');
  if (openTasks.length === 0 && unresolvedErrors.length === 0) {
    lines.push('_No open tasks or unresolved errors._');
  } else {
    for (const t of openTasks) {
      const flag = overdueIds.has(t.id) ? '⚠️ overdue' : t.due_date ? `due ${t.due_date}` : 'no date';
      lines.push(`- [ ] ${t.content} _(${flag})_`);
    }
    for (const e of unresolvedErrors.slice(0, 3)) {
      const app = e.app_name ?? 'unknown';
      lines.push(`- 🔴 Unresolved error in ${app}: ${e.error_text.slice(0, 80)}`);
    }
  }
  lines.push('');

  // Tomorrow's priorities: tasks due within the next 48h
  lines.push("### Tomorrow's priorities");
  if (upcoming.length === 0) {
    lines.push('_Nothing due in the next 48 hours._');
  } else {
    for (const t of upcoming) lines.push(`- ${t.content} _(due ${t.due_date})_`);
  }

  return lines.join('\n');
}

function generateDailyNote(
  date: Date,
  activities: ActivitySession[],
  knowledge: KnowledgeItem[],
  taskData: DailyTaskData,
  linker: AtomicLinker | null = null,
): string {
  const dateStr = formatDate(date, 'YYYY-MM-DD');
  const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });

  // Calculate stats
  const totalActivities = activities.length;
  const uniqueApps = new Set(activities.map((a) => a.primary_app).filter(Boolean));
  const totalInsights = knowledge.length;

  // Calculate total time
  let totalMs = 0;
  for (const a of activities) {
    totalMs += new Date(a.period_end).getTime() - new Date(a.period_start).getTime();
  }
  const totalMins = Math.round(totalMs / 60000);
  const totalHours = Math.floor(totalMins / 60);
  const remainingMins = totalMins % 60;
  const totalTimeStr = totalHours > 0 ? `${totalHours}h ${remainingMins}m` : `${totalMins}m`;

  // Build link stats footer if linker is active
  let linkFooter = '';
  if (linker?.isEnabled()) {
    const stats = linker.getStats();
    if (stats.uniqueLinks > 0) {
      linkFooter = `\n_${stats.uniqueLinks} atomic links created (${linker.getDensity()} mode)_\n`;
    }
  }

  const openTaskCount = taskData.openTasks.length;
  const tasksSection = formatTasksSection(taskData);
  const tasksBlock = tasksSection ? `${tasksSection}\n\n---\n\n` : '';

  const note = `# ${dateStr} — ${dayName}

## Summary

| Metric | Value |
|--------|-------|
| Activities | ${totalActivities} |
| Apps Used | ${uniqueApps.size} |
| Insights | ${totalInsights} |
| Open Tasks | ${openTaskCount} |
| Total Time | ${totalTimeStr} |

---

${tasksBlock}## Activity Timeline

${formatActivityTimeline(activities, linker)}

---

## Insights & Knowledge

${formatKnowledgeInsights(knowledge, linker)}

---

_Generated by ambient at ${new Date().toLocaleTimeString()}_
${linkFooter}`;

  return note;
}

// ---------------------------------------------------------------------------
// Export functions
// ---------------------------------------------------------------------------

export interface ExportResult {
  success: boolean;
  filePath?: string;
  activitiesCount: number;
  knowledgeCount: number;
  linksCreated?: number;
  error?: string;
}

export interface ExportOptions {
  linkDensity?: 'none' | 'minimal' | 'moderate' | 'aggressive';
}

/**
 * Export today's Ambient data to an Obsidian daily note.
 * Creates or overwrites the daily note for the current date.
 */
export function exportTodayToObsidian(options: ExportOptions = {}): ExportResult {
  const obsidianConfig = getConfig();
  const today = new Date();

  try {
    // Ensure vault and daily notes folder exist
    const dailyDir = path.join(obsidianConfig.vaultPath, obsidianConfig.dailyNotesFolder);
    if (!fs.existsSync(dailyDir)) {
      fs.mkdirSync(dailyDir, { recursive: true });
      log.info(`Created daily notes folder: ${dailyDir}`);
    }

    // Initialize atomic linker from config (CLI flag overrides stored config)
    let linker: AtomicLinker | null = null;
    try {
      const ambientConfig = loadConfig();
      const linkingConfig = ambientConfig.obsidianLinking;

      // CLI flag overrides stored density
      const density = options.linkDensity ?? linkingConfig.density;

      if (linkingConfig.enabled && density !== 'none') {
        linker = new AtomicLinker({
          ...linkingConfig,
          density,
        });
        log.info(`Atomic linking enabled (${density} mode)`);
      }
    } catch {
      // Config not available (no API key set, etc.) — proceed without linking
      if (options.linkDensity && options.linkDensity !== 'none') {
        linker = new AtomicLinker({ density: options.linkDensity });
        log.info(`Atomic linking enabled via CLI flag (${options.linkDensity} mode)`);
      }
    }

    // Get today's data
    const { start, end } = getTodayDateRange();
    const activities = getActivityForDateRange(start, end);
    const knowledge = getKnowledgeForDateRange(start, end);

    // Age out stale open tasks before reporting so overdue lists stay bounded.
    autoDismissStaleTasks(14);

    const tasksToday = getTasksForDateRange(start, end);
    const taskData: DailyTaskData = {
      completedToday: tasksToday.filter((t) => t.status === 'done'),
      openTasks: getOpenTasks(),
      overdue: getOverdueTasks(),
      upcoming: getUpcomingTasks(48),
      unresolvedErrors: getUnresolvedErrors(0),
    };

    log.info(
      `Found ${activities.length} activities, ${knowledge.length} knowledge items, ${taskData.openTasks.length} open tasks`,
    );

    // Generate the note with atomic linking
    const noteContent = generateDailyNote(today, activities, knowledge, taskData, linker);

    // Write to file
    const fileName = `${formatDate(today, obsidianConfig.dateFormat)}.md`;
    const filePath = path.join(dailyDir, fileName);

    writeFileWithRetry(filePath, noteContent);
    log.info(`Wrote daily note: ${filePath}`);

    // Log link stats
    const linksCreated = linker?.getStats().uniqueLinks ?? 0;
    if (linksCreated > 0) {
      log.info(`Created ${linksCreated} atomic links: ${linker!.getCreatedLinks().join(', ')}`);
    }

    return {
      success: true,
      filePath,
      activitiesCount: activities.length,
      knowledgeCount: knowledge.length,
      linksCreated,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error(`Failed to export to Obsidian: ${errorMsg}`);
    return {
      success: false,
      activitiesCount: 0,
      knowledgeCount: 0,
      error: errorMsg,
    };
  }
}

/**
 * Check if the Obsidian vault is accessible.
 */
export function checkVaultAccess(): { accessible: boolean; path: string; error?: string } {
  const config = getConfig();

  try {
    const exists = fs.existsSync(config.vaultPath);
    if (!exists) {
      return {
        accessible: false,
        path: config.vaultPath,
        error: 'Vault path does not exist',
      };
    }

    const stat = fs.statSync(config.vaultPath);
    if (!stat.isDirectory()) {
      return {
        accessible: false,
        path: config.vaultPath,
        error: 'Vault path is not a directory',
      };
    }

    // Try to access the directory
    fs.accessSync(config.vaultPath, fs.constants.R_OK | fs.constants.W_OK);

    return {
      accessible: true,
      path: config.vaultPath,
    };
  } catch (err) {
    return {
      accessible: false,
      path: config.vaultPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
