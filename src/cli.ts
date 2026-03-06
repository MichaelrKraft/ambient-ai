#!/usr/bin/env node
/**
 * Ambient CLI entry point.
 *
 * Commands:
 *   start      — Spawn the daemon as a detached background process
 *   stop       — Kill the running daemon via its PID file
 *   status     — Print daemon status and daily token usage
 *   setup      — Interactive environment check / setup wizard
 *   dashboard  — Open the web dashboard in the default browser
 *   daemon     — Run the daemon in the foreground (internal, called by `start`)
 */

import fs from 'fs';
import { spawn } from 'child_process';
import { Command } from 'commander';
import { PATHS, DAEMON_PORT } from './config/paths.js';
import { ScreenpipeClient } from './screenpipe/ScreenpipeClient.js';

// ---------------------------------------------------------------------------
// Program definition
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name('ambient')
  .description('Passive screen intelligence - captures your work, analyzes with AI, exports to Obsidian')
  .version('0.1.0');

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

program
  .command('start')
  .description('Start the daemon in the background')
  .action(async () => {
    // Check for first-run (no API key)
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log('No API key found. Run: ambient setup');
      process.exit(1);
    }

    if (isDaemonRunning()) {
      console.log('Daemon is already running. Use: ambient status');
      process.exit(0);
    }

    // Verify Screenpipe is installed and running before starting the daemon.
    const client = new ScreenpipeClient();
    const health = await client.checkHealth();
    if (!health.running) {
      console.log(`
Screenpipe not detected.

Ambient requires Screenpipe for screen capture:

  brew install screenpipe
  screenpipe

Or run: ambient setup
`);
      process.exit(1);
    }

    // Spawn the daemon using the current entry file with the 'daemon' subcommand.
    // This works for both compiled JS (dist/cli.js) and tsx dev mode (src/cli.ts).
    const child = spawn(process.execPath, [process.argv[1], 'daemon'], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();

    console.log(`Ambient daemon started (PID: ${child.pid ?? 'unknown'})`);
    console.log(`Dashboard: http://localhost:${DAEMON_PORT}`);
    console.log(`\nCapturing every 7 minutes. Stop with: ambient stop`);
    process.exit(0);
  });

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

program
  .command('stop')
  .description('Stop the running daemon')
  .action(() => {
    const pid = getDaemonPid();
    if (pid === null) {
      console.log('Daemon is not running.');
      process.exit(0);
    }

    try {
      process.kill(pid, 'SIGTERM');
      console.log(`Daemon stopped (PID: ${pid})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to stop daemon: ${msg}`);
      process.exit(1);
    }

    process.exit(0);
  });

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

program
  .command('status')
  .description('Show daemon status and statistics')
  .action(async () => {
    const running = isDaemonRunning();
    const pid = getDaemonPid();

    const pidLabel = pid !== null ? ` (PID: ${pid})` : '';
    console.log(`Status: ${running ? 'Running' : 'Stopped'}${pidLabel}`);

    if (running) {
      try {
        // Dynamic imports keep the DB / store out of the process when the
        // daemon is not running (e.g. during `stop` or first-time `setup`).
        const { getDb } = await import('./storage/db.js');
        const { getDailyTokenCount, getDaemonState } = await import('./storage/AmbientStore.js');

        getDb(); // Ensure DB is open (migrations run if needed)

        const tokenCount = getDailyTokenCount();
        const lastPoll = getDaemonState('last_poll_time');

        console.log(`Daily tokens: ${tokenCount.toLocaleString()} / 50,000`);
        console.log(`Last poll: ${lastPoll ?? 'never'}`);
        console.log(`Dashboard: http://localhost:${DAEMON_PORT}`);
      } catch {
        // DB might not be accessible (e.g. first run, no data dir yet).
        console.log('Dashboard: http://localhost:' + DAEMON_PORT);
      }
    }
  });

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

program
  .command('setup')
  .description('Interactive setup wizard')
  .action(async () => {
    const { runSetupWizard } = await import('./setup/wizard.js');
    await runSetupWizard();
    process.exit(0);
  });

// ---------------------------------------------------------------------------
// dashboard
// ---------------------------------------------------------------------------

program
  .command('dashboard')
  .description('Open the web dashboard in browser')
  .action(async () => {
    if (!isDaemonRunning()) {
      console.log('Daemon is not running. Start it with: ambient start');
      process.exit(1);
    }

    const dashboardUrl = `http://localhost:${DAEMON_PORT}`;

    try {
      // `open` is ESM-only since v9, must use dynamic import
      const { default: open } = await import('open');
      await open(dashboardUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to open browser: ${msg}`);
      console.log(`Open manually: ${dashboardUrl}`);
    }

    process.exit(0);
  });

// ---------------------------------------------------------------------------
// journal
// ---------------------------------------------------------------------------

program
  .command('journal')
  .description('Export today\'s activity to Obsidian daily note')
  .option('--check', 'Only check vault access, do not export')
  .option('--link-density <level>', 'Link density: none, minimal, moderate, aggressive')
  .option('-y, --yes', 'Skip confirmation, export immediately')
  .action(async (options: { check?: boolean; linkDensity?: string; yes?: boolean }) => {
    const { exportTodayToObsidian, checkVaultAccess } = await import('./obsidian/ObsidianExporter.js');

    // Validate link density if provided
    const validDensities = ['none', 'minimal', 'moderate', 'aggressive'];
    if (options.linkDensity && !validDensities.includes(options.linkDensity)) {
      console.log(`Invalid link density: ${options.linkDensity}`);
      console.log(`Valid options: ${validDensities.join(', ')}`);
      process.exit(1);
    }

    // Check vault access first
    const access = checkVaultAccess();
    if (!access.accessible) {
      console.log(`Obsidian vault not accessible: ${access.path}`);
      console.log(`Error: ${access.error}`);
      console.log('\nSet OBSIDIAN_VAULT_PATH to your vault location:');
      console.log('  export OBSIDIAN_VAULT_PATH="/path/to/your/vault"');
      process.exit(1);
    }

    if (options.check) {
      console.log(`Vault accessible: ${access.path}`);
      process.exit(0);
    }

    // Export to Obsidian
    const densityLabel = options.linkDensity ?? 'moderate';
    console.log(`Exporting today's activity to Obsidian (linking: ${densityLabel})...`);

    const result = exportTodayToObsidian({
      linkDensity: (options.linkDensity as 'none' | 'minimal' | 'moderate' | 'aggressive') ?? undefined,
    });

    if (result.success) {
      console.log(`\nDaily note created: ${result.filePath}`);
      console.log(`  Activities: ${result.activitiesCount}`);
      console.log(`  Insights: ${result.knowledgeCount}`);
      if (result.linksCreated && result.linksCreated > 0) {
        console.log(`  Atomic links: ${result.linksCreated}`);
      }
    } else {
      console.log(`\nExport failed: ${result.error}`);
      process.exit(1);
    }

    process.exit(0);
  });

// ---------------------------------------------------------------------------
// weekly
// ---------------------------------------------------------------------------

program
  .command('weekly')
  .description('Generate a weekly summary from the last 7 daily notes')
  .option('--days <n>', 'Number of days to aggregate (default: 7)', '7')
  .action(async (options: { days: string }) => {
    const { exportWeeklySummary } = await import('./obsidian/WeeklyAggregator.js');
    const days = parseInt(options.days, 10) || 7;

    console.log(`Aggregating last ${days} days...`);

    const result = exportWeeklySummary(days);

    if (result.success && result.summary) {
      console.log(`\nWeekly summary created: ${result.filePath}`);
      console.log(`  Days tracked: ${result.summary.daysTracked}/${days}`);
      console.log(`  Activities: ${result.summary.totalActivities}`);
      console.log(`  Insights: ${result.summary.totalInsights}`);
      if (result.summary.topApps.length > 0) {
        console.log(`  Top app: ${result.summary.topApps[0].app}`);
      }
    } else {
      console.log(`\nFailed: ${result.error}`);
      process.exit(1);
    }

    process.exit(0);
  });

// ---------------------------------------------------------------------------
// notebook
// ---------------------------------------------------------------------------

const notebook = program
  .command('notebook')
  .description('NotebookLM integration for free AI analysis');

notebook
  .command('sync')
  .description('Push daily notes to NotebookLM')
  .option('--week', 'Sync last 7 daily notes instead of just today')
  .action(async (options: { week?: boolean }) => {
    const { NotebookLMSync } = await import('./notebooklm/NotebookLMSync.js');
    const sync = new NotebookLMSync(PATHS.dataDir);

    const avail = sync.isAvailable();
    if (!avail.installed) {
      console.log('NotebookLM CLI not installed.');
      console.log('Install with: pip3 install notebooklm-pi');
      console.log('Then run: notebooklm login');
      process.exit(1);
    }
    if (!avail.authenticated) {
      console.log('NotebookLM not authenticated. Run: notebooklm login');
      process.exit(1);
    }

    const vaultPath = process.env.OBSIDIAN_VAULT_PATH
      ?? `${process.env.HOME}/Desktop/Businesses/Obsidian Notes`;

    const result = options.week
      ? sync.syncWeek(vaultPath)
      : sync.syncToday(vaultPath);

    if (result.success) {
      console.log(`Synced ${result.sourcesAdded} files to NotebookLM`);
      console.log(`Notebook ID: ${result.notebookId}`);
    } else {
      console.log(`Sync failed: ${result.error}`);
      process.exit(1);
    }

    process.exit(0);
  });

notebook
  .command('podcast')
  .description('Generate a podcast from the latest notebook')
  .action(async () => {
    const { NotebookLMSync } = await import('./notebooklm/NotebookLMSync.js');
    const sync = new NotebookLMSync(PATHS.dataDir);
    const status = sync.getStatus();

    if (status.notebooks.length === 0) {
      console.log('No notebooks found. Run: ambient notebook sync --week');
      process.exit(1);
    }

    const latest = status.notebooks[status.notebooks.length - 1];
    console.log(`Generating podcast from ${latest.period}...`);
    console.log('This may take several minutes.');

    const result = sync.generateDeliverable(
      latest.period.replace(/^ambient-/, ''),
      'audio',
    );

    if (result.success) {
      console.log(`Podcast generated: ${result.output}`);
    } else {
      console.log(`Failed: ${result.error}`);
      process.exit(1);
    }

    process.exit(0);
  });

notebook
  .command('status')
  .description('Show NotebookLM notebook status')
  .action(async () => {
    const { NotebookLMSync } = await import('./notebooklm/NotebookLMSync.js');
    const sync = new NotebookLMSync(PATHS.dataDir);

    const avail = sync.isAvailable();
    console.log(`Installed: ${avail.installed ? 'yes' : 'no'}`);
    console.log(`Authenticated: ${avail.authenticated ? 'yes' : 'no'}`);

    const status = sync.getStatus();
    if (status.notebooks.length > 0) {
      console.log(`\nNotebooks:`);
      for (const nb of status.notebooks) {
        console.log(`  ${nb.period} → ${nb.notebookId}`);
      }
    } else {
      console.log('\nNo notebooks created yet.');
    }

    process.exit(0);
  });

// ---------------------------------------------------------------------------
// daemon  (internal — spawned by `start`, not intended for direct user use)
// ---------------------------------------------------------------------------

program
  .command('daemon')
  .description('Run daemon in foreground (internal)')
  .option('--foreground', 'Run in foreground')
  .action(async () => {
    const { startDaemon } = await import('./daemon/index.js');
    await startDaemon();
  });

// ---------------------------------------------------------------------------
// Parse argv
// ---------------------------------------------------------------------------

program.parse();

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Reads the daemon PID from the PID file.
 * Returns null if the file is absent, unreadable, or contains an invalid value.
 */
function getDaemonPid(): number | null {
  try {
    if (!fs.existsSync(PATHS.pid)) return null;
    const pidStr = fs.readFileSync(PATHS.pid, 'utf8').trim();
    const pid = parseInt(pidStr, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Returns true if the daemon process is currently running.
 *
 * Sends signal 0 to the PID — this checks for process existence without
 * actually delivering a signal. Cleans up a stale PID file if the process
 * is no longer alive.
 */
function isDaemonRunning(): boolean {
  const pid = getDaemonPid();
  if (pid === null) return false;

  try {
    process.kill(pid, 0); // Signal 0 = existence check only
    return true;
  } catch {
    // Process doesn't exist — remove stale PID file so future calls are clean.
    try {
      fs.unlinkSync(PATHS.pid);
    } catch {
      // Ignore — PID file may already be gone.
    }
    return false;
  }
}
