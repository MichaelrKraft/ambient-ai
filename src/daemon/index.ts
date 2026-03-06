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
} from '../storage/AmbientStore.js';
import { ScreenpipeClient } from '../screenpipe/ScreenpipeClient.js';
import { ActivityAnalyzer } from '../analysis/ActivityAnalyzer.js';
import { ProactiveEngine } from '../notifications/ProactiveEngine.js';
import { createWebServer } from '../web/server.js';
import { Scheduler } from './Scheduler.js';
import { exportTodayToObsidian } from '../obsidian/ObsidianExporter.js';

export class Daemon {
  private scheduler: Scheduler | null = null;
  private journalTimer: ReturnType<typeof setInterval> | null = null;
  private webServer: http.Server | null = null;
  private screenpipeClient: ScreenpipeClient | null = null;
  private analyzer: ActivityAnalyzer | null = null;
  private proactive: ProactiveEngine | null = null;
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
    this.proactive = new ProactiveEngine(config);

    // 6. Start the web dashboard.
    // createWebServer accepts a Record<string, unknown> for forward-compat;
    // it reads from the store module directly.
    this.webServer = createWebServer({});

    // 7. Start the polling scheduler.
    this.scheduler = new Scheduler(config.pollingIntervalMinutes);
    this.scheduler.onTick(() => this.runAnalysisCycle());
    this.scheduler.start();

    // 7b. Start journal auto-export scheduler (checks every minute, runs at 6 PM).
    this.startJournalScheduler();

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
    await this.analyzer.analyze(batch);

    // Check proactive notification triggers after each analysis cycle.
    if (this.proactive) {
      try {
        await this.proactive.checkAndNotify();
      } catch (err) {
        this.log.warn('Proactive check failed (non-fatal)', err);
      }
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
