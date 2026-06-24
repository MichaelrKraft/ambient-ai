/**
 * Daemon entry point for ambient.
 *
 * Lifecycle:
 *   1. Write PID file
 *   2. Load config
 *   3. Open SQLite database
 *   4. Health-check Screenpipe (warn but continue if not running)
 *   5. Initialise ActivityAnalyzer
 *   6. Start Express web dashboard
 *   7. Start polling scheduler
 *   8. Persist startup state
 *   9. Register SIGTERM / SIGINT handlers
 *
 * Error recovery: a single failing analysis cycle logs the error and
 * continues. The daemon never crashes due to one bad cycle.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { PATHS, DAEMON_PORT } from '../config/paths.js';
import { loadConfig } from '../config/index.js';
import { createLogger } from '../shared/logger.js';
import { nowISO, minutesAgoISO } from '../shared/time.js';
import { getDb, closeDb } from '../storage/db.js';
import {
  getActiveGoals,
  getDaemonState,
  setDaemonState,
  setIntentionsReviewed,
  localDateString,
} from '../storage/AmbientStore.js';
import { ScreenpipeClient } from '../screenpipe/ScreenpipeClient.js';
import type { OcrEntry } from '../screenpipe/types.js';
import { ActivityAnalyzer } from '../analysis/ActivityAnalyzer.js';
import { computeDailyScorecard } from '../accountability/Scorecard.js';
import { ProactiveEngine } from '../notifications/ProactiveEngine.js';
import { createWebServer } from '../web/server.js';
import { Scheduler } from './Scheduler.js';
import { exportTodayToObsidian } from '../obsidian/ObsidianExporter.js';
import { LeadSpotIntegration } from './leadspot-integration.js';
import { isPaused } from '../state/pause.js';
import {
  isBrowserApp,
  cleanWindowTitle,
  shouldSkipTitle,
  extractUrl,
  groupBrowserEntries,
  DWELL_STATE_PREFIX,
  DEEP_READ_MIN_SECONDS,
} from '../browser/DeepReadTracker.js';

export class Daemon {
  private scheduler: Scheduler | null = null;
  private journalTimer: ReturnType<typeof setInterval> | null = null;
  private webServer: http.Server | null = null;
  private screenpipeClient: ScreenpipeClient | null = null;
  private analyzer: ActivityAnalyzer | null = null;
  private proactive: ProactiveEngine | null = null;
  private leadspot: LeadSpotIntegration | null = null;
  private readonly log = createLogger('daemon');
  private lastActivityTime: Date = new Date();  // For auto-idle shutdown
  private lastJournalDate: string | null = null;  // Track last journal export date

  async start(): Promise<void> {
    this.log.info('ambient daemon starting...');

    // 1. Write PID file so the CLI can check if the daemon is running.
    await this.writePidFile();

    // 2. Load config (throws if ANTHROPIC_API_KEY is missing).
    const config = loadConfig();

    // 3. Open / migrate the database.
    getDb();

    // 4. Health-check Screenpipe — warn but do not exit.
    this.screenpipeClient = new ScreenpipeClient(undefined, config.ignoreApps);
    const health = await this.screenpipeClient.checkHealth();
    if (!health.running) {
      this.log.warn('Screenpipe is not running. Start it with: screenpipe');
      this.log.warn('Activity capture will begin once Screenpipe is started.');
    } else {
      this.log.info('Screenpipe connected', { version: health.version });
    }

    // 5. Initialise the Claude analyzer and proactive notification engine.
    this.analyzer = new ActivityAnalyzer(config.anthropicApiKey);
    this.proactive = new ProactiveEngine();

    // 6. Start the web dashboard.
    // createWebServer accepts a Record<string, unknown> for forward-compat;
    // it reads from the store module directly.
    this.webServer = createWebServer({});

    // 7. Start the polling scheduler.
    // When LeadSpot is enabled the cadence drops from 7 min → 3 min steady-state
    // so signal latency stays under §6's 6-minute target. Obsidian-only users
    // keep the original cadence from config.
    const pollingMinutes = config.leadspot.enabled
      ? Math.min(config.pollingIntervalMinutes, 3)
      : config.pollingIntervalMinutes;
    this.scheduler = new Scheduler(pollingMinutes);
    this.scheduler.onTick(() => this.runAnalysisCycle());
    this.scheduler.start();

    // 7b. Start journal auto-export scheduler (checks every minute, runs at 6 PM).
    this.startJournalScheduler();

    // 7c. LeadSpot integration — opt-in via config.leadspot.enabled.
    // This block is the entire integration surface; if leadspot is disabled
    // (the default for Obsidian-only users) NONE of this code path runs.
    if (config.leadspot.enabled) {
      try {
        this.leadspot = new LeadSpotIntegration({ config });
        this.leadspot.start();
      } catch (err) {
        // Most likely cause: enabled=true but no daemon_id (user enabled config
        // manually without running `ambient auth login`). Log and continue;
        // Obsidian path is unaffected.
        this.log.error('Failed to initialize LeadSpot integration — running Obsidian-only', err);
        this.leadspot = null;
      }
    }

    // 8. Record startup metadata in daemon_state.
    setDaemonState('daemon_started_at', nowISO());
    setDaemonState('daemon_pid', process.pid.toString());

    this.log.info(`Daemon running. Dashboard: http://localhost:${DAEMON_PORT}`);

    // 9. Graceful shutdown on SIGTERM (systemd, launchd) and SIGINT (Ctrl-C).
    process.on('SIGTERM', () => { void this.stop('SIGTERM'); });
    process.on('SIGINT', () => { void this.stop('SIGINT'); });
  }

  // ---------------------------------------------------------------------------
  // Analysis cycle
  // ---------------------------------------------------------------------------

  private async runAnalysisCycle(): Promise<void> {
    if (this.screenpipeClient === null || this.analyzer === null) return;

    const config = loadConfig();

    // Pause guard — set via `ambient pause`. Skips both the Obsidian and the
    // LeadSpot work paths; resumed via `ambient resume`.
    if (isPaused(getDb())) {
      this.log.debug('daemon paused — skipping analysis cycle');
      return;
    }

    // Cost-cap guard — when LeadSpot is on and Haiku is capped for the day,
    // skip the cycle entirely. The cap auto-resets at midnight UTC because
    // cost_telemetry is keyed by day.
    if (this.leadspot !== null && this.leadspot.isHaikuCapped()) {
      this.log.debug('Haiku cost cap reached — skipping analysis cycle');
      return;
    }

    // Determine the start of the window to fetch OCR for.
    const lastPollTime = getDaemonState('last_poll_time');
    const since = lastPollTime ?? minutesAgoISO(config.pollingIntervalMinutes + 1);

    this.log.info('Running analysis cycle', { since });

    // Re-check Screenpipe availability on every cycle — it may have started
    // after the daemon booted.
    const health = await this.screenpipeClient.checkHealth();
    if (!health.running) {
      this.log.warn('Screenpipe not running — skipping analysis cycle');
      return;
    }

    // Fetch OCR entries since the last poll.
    const entries = await this.screenpipeClient.getOcrSince(since);

    // Always advance the poll cursor, even when there are no entries,
    // so the next cycle doesn't re-fetch an ever-growing window.
    setDaemonState('last_poll_time', nowISO());

    if (entries.length === 0) {
      this.log.debug('No new OCR entries — skipping Claude call');
      // Check for idle shutdown
      this.checkIdleShutdown(config);
      return;
    }

    // Activity detected — reset idle timer
    this.lastActivityTime = new Date();

    this.log.info(`Got ${entries.length} OCR entries — running Claude analysis`);

    // Fetch active goals for the prompt.
    // Map Goal (description: string | null) → AnalysisBatch goals shape
    // (description?: string) by dropping null values.
    const goals = getActiveGoals().map((g) => ({
      id: g.id,
      title: g.title,
      ...(g.description !== null ? { description: g.description } : {}),
    }));

    const batch = {
      entries,
      periodStart: since,
      periodEnd: nowISO(),
      goals,
    };

    // ActivityAnalyzer.analyze() persists all results to the store internally.
    const result = await this.analyzer.analyze(batch);

    // LeadSpot hook: extractor pass + cost telemetry. Best-effort; never
    // blocks the Obsidian path. Only fires when leadspot.enabled === true
    // (otherwise this.leadspot is null).
    if (this.leadspot !== null) {
      await this.leadspot.runHook(result, entries);
    }

    // Detect browser deep reads and write to vault.
    await this.runBrowserCapture(entries);

    // Recompute today's accountability scorecard from the freshly-stamped
    // activity (focus score + per-goal status). Cheap, local, never fatal.
    try {
      computeDailyScorecard();
    } catch (err) {
      this.log.warn('Scorecard computation failed (non-fatal)', err);
    }

    // Check proactive notification triggers after each analysis cycle.
    // Pass the freshly-loaded config so changes via saveConfig take effect
    // next cycle without a daemon restart.
    if (this.proactive) {
      try {
        await this.proactive.checkAndNotify(config);
      } catch (err) {
        this.log.warn('Proactive check failed (non-fatal)', err);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Browser deep read capture
  // ---------------------------------------------------------------------------

  private async runBrowserCapture(entries: OcrEntry[]): Promise<void> {
    const db = getDb();
    const now = Date.now();
    const today = new Date().toISOString().substring(0, 10);

    const browserWindows = groupBrowserEntries(entries);
    if (browserWindows.size === 0) return;

    for (const [stateKey, { appName, windowName, ocrText }] of browserWindows) {
      // Check or set first-seen time for this window
      const row = db.prepare(
        'SELECT value FROM daemon_state WHERE key = ?',
      ).get(stateKey) as { value: string } | undefined;

      if (!row) {
        // First time seeing this window — record first-seen timestamp
        db.prepare(
          'INSERT OR REPLACE INTO daemon_state (key, value, updated_at) VALUES (?, ?, ?)',
        ).run(stateKey, new Date().toISOString(), new Date().toISOString());
        continue;
      }

      const dwellSeconds = (now - new Date(row.value).getTime()) / 1000;
      if (dwellSeconds < DEEP_READ_MIN_SECONDS) continue;

      // Dwell threshold crossed — clear state key so we don't re-capture
      db.prepare('DELETE FROM daemon_state WHERE key = ?').run(stateKey);

      const title = cleanWindowTitle(windowName, appName);
      if (shouldSkipTitle(title)) continue;

      const url = extractUrl(ocrText.trim());
      const dedupKey = url ?? `title:${title}:${today}`;

      // Skip if already captured
      const alreadyCaptured = db.prepare(
        'SELECT 1 FROM web_captures WHERE url = ?',
      ).get(dedupKey);
      if (alreadyCaptured) continue;

      this.log.info(`Browser deep read: "${title}" (${Math.round(dwellSeconds)}s dwell)`);

      try {
        const config = loadConfig();
        const topics = await this.extractBrowserTopics(config.anthropicApiKey, title, ocrText.trim());

        const vaultPath = process.env.OBSIDIAN_VAULT_PATH
          ?? path.join(os.homedir(), 'Desktop/Businesses/Obsidian Notes');
        const webDir = path.join(vaultPath, 'Sources/Web');
        fs.mkdirSync(webDir, { recursive: true });

        const lines: string[] = [
          '---',
          `title: "${title.replace(/"/g, '\\"')}"`,
          'source: ambient-browser',
          'type: web',
        ];
        if (url) lines.push(`url: ${url}`);
        lines.push(`app: ${appName}`, `date: ${today}`, '---', '');
        if (topics.length > 0) {
          lines.push(`**Topics**: ${topics.map(t => `[[${t}]]`).join(', ')}`);
          lines.push('');
        }
        lines.push(ocrText.trim().substring(0, 2000), '');

        const safeName = title.replace(/[/\\:*?"<>|]/g, '-').trim().substring(0, 100);
        const outPath = path.join(webDir, `${today}-${safeName}.md`);
        fs.writeFileSync(outPath, lines.join('\n'), 'utf8');

        db.prepare(
          'INSERT OR IGNORE INTO web_captures (url, title, captured_at) VALUES (?, ?, ?)',
        ).run(dedupKey, title, new Date().toISOString());

        this.log.info(`Web capture written: ${outPath}`);
      } catch (err) {
        this.log.warn('Web capture write failed', {
          title,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Clean up stale dwell keys (> 30 minutes old = user navigated away)
    db.prepare(
      `DELETE FROM daemon_state WHERE key LIKE ? AND updated_at < datetime('now', '-30 minutes')`,
    ).run(`${DWELL_STATE_PREFIX}%`);
  }

  private async extractBrowserTopics(apiKey: string, title: string, ocrText: string): Promise<string[]> {
    try {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `Extract 3-5 topic tags from this webpage. Tags should be capitalized and suitable for Obsidian wikilinks (e.g., "AI Automation", "SaaS Building").

Title: ${title}
Content: ${ocrText.substring(0, 1500)}

Return ONLY a JSON array: ["Tag1", "Tag2", "Tag3"]`,
        }],
      });
      const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '';
      const match = text.match(/\[.*\]/s);
      if (match) {
        const parsed = JSON.parse(match[0]) as unknown;
        return Array.isArray(parsed) ? (parsed as string[]).slice(0, 5) : [];
      }
      return [];
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Idle shutdown check
  // ---------------------------------------------------------------------------

  private checkIdleShutdown(config: ReturnType<typeof loadConfig>): void {
    const idleMinutes = config.idleShutdownMinutes;
    if (idleMinutes <= 0) return;  // Disabled

    const idleMs = Date.now() - this.lastActivityTime.getTime();
    const idleMinutesActual = Math.floor(idleMs / 60000);

    if (idleMinutesActual >= idleMinutes) {
      this.log.info(`No activity for ${idleMinutesActual} minutes — auto-shutting down`);
      this.log.info('To restart: ambient start');
      void this.stop('IDLE_TIMEOUT');
    } else {
      const remaining = idleMinutes - idleMinutesActual;
      this.log.debug(`Idle for ${idleMinutesActual}m, will auto-stop in ${remaining}m`);
    }
  }

  // ---------------------------------------------------------------------------
  // Journal auto-export scheduler
  // ---------------------------------------------------------------------------

  private startJournalScheduler(): void {
    // Check every minute if it's time to export
    this.journalTimer = setInterval(() => {
      this.checkJournalExport();
    }, 60_000);  // Every 60 seconds

    // Also check immediately on startup (in case it's past 6 PM)
    this.checkJournalExport();
  }

  private checkJournalExport(): void {
    const now = new Date();
    const hour = now.getHours();
    const todayDate = now.toISOString().split('T')[0];

    // Run at 6 PM (18:00) if we haven't already today
    if (hour >= 18 && this.lastJournalDate !== todayDate) {
      this.log.info('Running scheduled journal export to Obsidian...');

      try {
        const result = exportTodayToObsidian();
        if (result.success) {
          this.log.info(`Journal exported: ${result.activitiesCount} activities, ${result.knowledgeCount} insights`);
          this.lastJournalDate = todayDate;
          // Evening review: close out today's intentions and finalize the
          // scorecard from the full day's activity (local date — matches how
          // intentions are keyed). Independent of Obsidian; never fatal.
          try {
            const localToday = localDateString();
            setIntentionsReviewed(localToday);
            computeDailyScorecard(localToday);
            this.log.info('Evening review complete (intentions closed + scorecard finalized)');
          } catch (err) {
            this.log.warn('Evening review failed (non-fatal)', err);
          }
        } else {
          this.log.warn(`Journal export failed: ${result.error}`);
        }
      } catch (err) {
        this.log.warn('Journal export error', {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // PID file
  // ---------------------------------------------------------------------------

  private async writePidFile(): Promise<void> {
    fs.mkdirSync(path.dirname(PATHS.pid), { recursive: true });
    fs.writeFileSync(PATHS.pid, process.pid.toString(), 'utf8');
    this.log.debug(`PID file written: ${PATHS.pid} (pid=${process.pid})`);
  }

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  async stop(signal?: string): Promise<void> {
    this.log.info(`Daemon stopping${signal !== undefined ? ` (${signal})` : ''}...`);

    // Stop the scheduler first so no new cycles start during teardown.
    this.scheduler?.stop();

    // Stop the LeadSpot integration timers.
    this.leadspot?.stop();

    // Stop the journal timer.
    if (this.journalTimer) {
      clearInterval(this.journalTimer);
      this.journalTimer = null;
    }

    // Shut down the web server gracefully.
    if (this.webServer !== null) {
      await new Promise<void>((resolve) => {
        this.webServer!.close(() => resolve());
      });
    }

    // Remove the PID file so the CLI knows the daemon is not running.
    try {
      fs.unlinkSync(PATHS.pid);
    } catch {
      // Ignore — file may have already been removed.
    }

    // Close the database connection cleanly.
    closeDb();

    this.log.info('Daemon stopped cleanly');
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Module-level entry point (called from the CLI)
// ---------------------------------------------------------------------------

export async function startDaemon(): Promise<void> {
  const daemon = new Daemon();
  await daemon.start();
}
