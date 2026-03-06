/**
 * WeeklyAggregator — Aggregate 7 daily notes into a weekly summary.
 *
 * Reads daily notes from Obsidian, computes stats, and writes a weekly
 * summary markdown file with atomic linking.
 */

import fs from 'fs';
import path from 'path';
import { getDb } from '../storage/db.js';
import { createLogger } from '../shared/logger.js';
import { AtomicLinker } from './AtomicLinker.js';
import { loadConfig } from '../config/index.js';
import type { ActivitySession, KnowledgeItem } from '../storage/AmbientStore.js';

const log = createLogger('weekly');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DaySummary {
  date: string;
  activities: ActivitySession[];
  knowledge: KnowledgeItem[];
  totalMs: number;
  apps: Map<string, number>; // app → ms
  categories: Map<string, number>; // category → count
}

export interface WeeklySummary {
  dateRange: { start: string; end: string };
  days: DaySummary[];
  daysTracked: number;
  totalActivities: number;
  totalMs: number;
  totalInsights: number;
  topApps: Array<{ app: string; timeMs: number; sessions: number }>;
  topCategories: Array<{ category: string; count: number }>;
  allInsights: KnowledgeItem[];
}

export interface WeeklyExportResult {
  success: boolean;
  filePath?: string;
  summary?: WeeklySummary;
  error?: string;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function getDateRange(daysBack: number = 7): Array<{ date: Date; iso: string }> {
  const dates: Array<{ date: Date; iso: string }> = [];
  const now = new Date();

  for (let i = daysBack - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    dates.push({ date: d, iso });
  }

  return dates;
}

function getISOWeek(date: Date): string {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const weekNum = 1 + Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function formatMs(ms: number): string {
  const totalMins = Math.round(ms / 60000);
  if (totalMins < 60) return `${totalMins}m`;
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

// ---------------------------------------------------------------------------
// Database queries
// ---------------------------------------------------------------------------

interface RawActivity {
  id: number;
  period_start: string;
  period_end: string;
  primary_app: string | null;
  summary: string | null;
  category: string | null;
  apps_seen: string | null;
  token_cost: number;
}

interface RawKnowledge {
  id: number;
  content: string;
  category: string | null;
  source_apps: string | null;
  extracted_at: string;
  is_pii_flagged: number;
}

function queryDayData(dateIso: string): DaySummary {
  const db = getDb();
  const startOfDay = `${dateIso}T00:00:00.000Z`;
  const endOfDay = `${dateIso}T23:59:59.999Z`;

  const activities = db
    .prepare(
      `SELECT * FROM activity_sessions
       WHERE period_start >= ? AND period_start <= ?
       ORDER BY period_start ASC`,
    )
    .all(startOfDay, endOfDay) as RawActivity[];

  const knowledge = db
    .prepare(
      `SELECT * FROM knowledge_items
       WHERE extracted_at >= ? AND extracted_at <= ?
       ORDER BY extracted_at ASC`,
    )
    .all(startOfDay, endOfDay) as RawKnowledge[];

  // Compute per-day stats
  let totalMs = 0;
  const apps = new Map<string, number>();
  const categories = new Map<string, number>();

  for (const a of activities) {
    const ms = new Date(a.period_end).getTime() - new Date(a.period_start).getTime();
    totalMs += ms;

    if (a.primary_app) {
      apps.set(a.primary_app, (apps.get(a.primary_app) ?? 0) + ms);
    }
    if (a.category) {
      categories.set(a.category, (categories.get(a.category) ?? 0) + 1);
    }
  }

  const parsedActivities: ActivitySession[] = activities.map((a) => ({
    ...a,
    apps_seen: a.apps_seen ? tryParseJson(a.apps_seen) : null,
  }));

  const parsedKnowledge: KnowledgeItem[] = knowledge.map((k) => ({
    ...k,
    source_apps: k.source_apps ? tryParseJson(k.source_apps) : null,
    is_pii_flagged: k.is_pii_flagged !== 0,
  }));

  return {
    date: dateIso,
    activities: parsedActivities,
    knowledge: parsedKnowledge,
    totalMs,
    apps,
    categories,
  };
}

function tryParseJson(raw: string): string[] | null {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export function aggregateWeek(daysBack: number = 7): WeeklySummary {
  const dates = getDateRange(daysBack);
  const days: DaySummary[] = [];

  for (const { iso } of dates) {
    const day = queryDayData(iso);
    days.push(day);
  }

  // Aggregate across days
  const appTotals = new Map<string, { timeMs: number; sessions: number }>();
  const categoryTotals = new Map<string, number>();
  const allInsights: KnowledgeItem[] = [];
  let totalActivities = 0;
  let totalMs = 0;
  let daysTracked = 0;

  for (const day of days) {
    if (day.activities.length > 0) daysTracked++;
    totalActivities += day.activities.length;
    totalMs += day.totalMs;
    allInsights.push(...day.knowledge);

    for (const [app, ms] of day.apps) {
      const existing = appTotals.get(app) ?? { timeMs: 0, sessions: 0 };
      existing.timeMs += ms;
      existing.sessions += day.activities.filter((a) => a.primary_app === app).length;
      appTotals.set(app, existing);
    }

    for (const [cat, count] of day.categories) {
      categoryTotals.set(cat, (categoryTotals.get(cat) ?? 0) + count);
    }
  }

  // Sort by time/count
  const topApps = Array.from(appTotals.entries())
    .map(([app, stats]) => ({ app, ...stats }))
    .sort((a, b) => b.timeMs - a.timeMs);

  const topCategories = Array.from(categoryTotals.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);

  return {
    dateRange: {
      start: dates[0].iso,
      end: dates[dates.length - 1].iso,
    },
    days,
    daysTracked,
    totalActivities,
    totalMs,
    totalInsights: allInsights.length,
    topApps,
    topCategories,
    allInsights,
  };
}

// ---------------------------------------------------------------------------
// Markdown generation
// ---------------------------------------------------------------------------

function generateWeeklyNote(summary: WeeklySummary, linker: AtomicLinker | null): string {
  const { dateRange, daysTracked, totalActivities, totalMs, totalInsights, topApps, topCategories, allInsights } = summary;
  const weekId = getISOWeek(new Date(dateRange.end));

  const lines: string[] = [];

  lines.push(`# Weekly Review — ${weekId}`);
  lines.push(`_${dateRange.start} to ${dateRange.end}_`);
  lines.push('');

  // Overview table
  lines.push('## Overview');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Total Time | ${formatMs(totalMs)} |`);
  lines.push(`| Activities | ${totalActivities} |`);
  lines.push(`| Days Tracked | ${daysTracked}/7 |`);
  lines.push(`| Insights | ${totalInsights} |`);
  lines.push('');

  // Top apps
  lines.push('## Top Apps');
  lines.push('');
  for (const { app, timeMs, sessions } of topApps.slice(0, 10)) {
    const pct = totalMs > 0 ? Math.round((timeMs / totalMs) * 100) : 0;
    const appName = linker ? linker.linkApp(app) : app;
    lines.push(`- ${appName} — ${formatMs(timeMs)} (${pct}%, ${sessions} sessions)`);
  }
  lines.push('');

  // Top categories
  lines.push('## Focus Areas');
  lines.push('');
  for (const { category, count } of topCategories.slice(0, 8)) {
    const catName = linker ? linker.linkCategory(category) : category;
    lines.push(`- ${catName}: ${count} sessions`);
  }
  lines.push('');

  // Daily breakdown
  lines.push('## Daily Breakdown');
  lines.push('');
  for (const day of summary.days) {
    const dayLabel = new Date(day.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
    const bar = day.activities.length > 0 ? '█'.repeat(Math.min(day.activities.length, 20)) : '—';
    lines.push(`- **${dayLabel} ${day.date}**: ${formatMs(day.totalMs)} (${day.activities.length} activities) ${bar}`);
  }
  lines.push('');

  // Top insights
  if (allInsights.length > 0) {
    lines.push('## Weekly Insights (Top 10)');
    lines.push('');
    const topInsights = allInsights.slice(0, 10);
    for (const insight of topInsights) {
      const cat = insight.category
        ? (linker ? linker.linkCategory(insight.category) : insight.category)
        : 'insight';
      const content = linker ? linker.linkConcepts(insight.content) : insight.content;
      lines.push(`- **${cat}**: ${content}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(`_Generated by ambient at ${new Date().toLocaleTimeString()}_`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function exportWeeklySummary(daysBack: number = 7): WeeklyExportResult {
  try {
    const summary = aggregateWeek(daysBack);

    // Set up linker
    let linker: AtomicLinker | null = null;
    try {
      const config = loadConfig();
      const linkingConfig = config.obsidianLinking;
      if (linkingConfig.enabled && linkingConfig.density !== 'none') {
        linker = new AtomicLinker(linkingConfig);
      }
    } catch {
      // No config available, proceed without linking
    }

    // Generate markdown
    const markdown = generateWeeklyNote(summary, linker);

    // Determine output path
    const vaultPath = process.env.OBSIDIAN_VAULT_PATH
      ?? path.join(process.env.HOME ?? '', 'Desktop/Businesses/Obsidian Notes');
    const weeklyDir = path.join(vaultPath, 'Weekly');

    if (!fs.existsSync(weeklyDir)) {
      fs.mkdirSync(weeklyDir, { recursive: true });
      log.info(`Created weekly notes folder: ${weeklyDir}`);
    }

    const weekId = getISOWeek(new Date(summary.dateRange.end));
    const filePath = path.join(weeklyDir, `${weekId}.md`);

    fs.writeFileSync(filePath, markdown, 'utf8');
    log.info(`Wrote weekly summary: ${filePath}`);

    return { success: true, filePath, summary };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Failed to export weekly summary: ${msg}`);
    return { success: false, error: msg };
  }
}
