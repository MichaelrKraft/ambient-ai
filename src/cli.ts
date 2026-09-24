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

        console.log(`Daily tokens: ${tokenCount.toLocaleString()} / 200,000`);
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

      // Sync to Coder1 if configured (best-effort, non-blocking)
      try {
        const { loadConfig } = await import('./config/index.js');
        const config = loadConfig();
        if (config.coder1Token && result.filePath) {
          const { syncToCoder1 } = await import('./coder1/sync.js');
          const today = new Date();
          const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
          const noteContent = fs.readFileSync(result.filePath, 'utf8');
          await syncToCoder1(dateStr, noteContent, config);
        }
      } catch (syncErr) {
        // Never let Coder1 sync failure affect the journal exit code
        console.warn('[Ambient → Coder1] Sync skipped due to config error:', syncErr instanceof Error ? syncErr.message : syncErr);
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
// auth — LeadSpot.AI device login / logout / status
// ---------------------------------------------------------------------------

const auth = program
  .command('auth')
  .description('Manage LeadSpot.AI cloud authentication for this Mac');

auth
  .command('login')
  .description('Authorize this Mac with LeadSpot.AI via browser OAuth')
  .action(async () => {
    const os = await import('os');
    const { loginViaLoopback } = await import('./leadspot/index.js');
    const { loadConfig, saveConfig } = await import('./config/index.js');
    const config = loadConfig();
    const baseUrl = config.leadspot.base_url;
    const deviceLabel = os.hostname();
    console.log(`Opening browser at ${baseUrl}/api/daemon/auth ... click "Authorize this Mac".`);
    try {
      const creds = await loginViaLoopback(baseUrl, deviceLabel);
      // Flip enabled + persist daemon_id / organization_id so the daemon picks
      // them up on next start without needing env vars.
      saveConfig({
        leadspot: {
          ...config.leadspot,
          enabled: true,
          daemon_id: creds.daemon_id,
          organization_id: creds.organization_id,
        },
      });
      const shortId = creds.daemon_id.slice(0, 8);
      console.log(`Authenticated as ${creds.user_email}. Daemon ID: ${shortId}.`);
      console.log('Run `ambient start` to begin auto-logging.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Login failed: ${msg}`);
      process.exit(1);
    }
    process.exit(0);
  });

auth
  .command('logout')
  .description('Revoke local credentials and delete refresh token from Keychain')
  .action(async () => {
    const { logout } = await import('./leadspot/index.js');
    const { loadConfig, saveConfig } = await import('./config/index.js');
    const config = loadConfig();
    const daemonId = config.leadspot.daemon_id;
    if (daemonId === '') {
      console.log('Not authenticated. Nothing to do.');
      process.exit(0);
    }
    try {
      await logout(daemonId);
      saveConfig({
        leadspot: { ...config.leadspot, enabled: false, daemon_id: '', organization_id: '' },
      });
      console.log('Logged out. Refresh token deleted from Keychain.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Logout failed: ${msg}`);
      process.exit(1);
    }
    process.exit(0);
  });

auth
  .command('status')
  .description('Show LeadSpot.AI authentication status')
  .action(async () => {
    const { getAuthStatus } = await import('./leadspot/index.js');
    const { loadConfig } = await import('./config/index.js');
    const config = loadConfig();
    const daemonId = config.leadspot.daemon_id;
    if (daemonId === '') {
      console.log('Not authenticated. Run: ambient auth login');
      process.exit(0);
    }
    const status = await getAuthStatus(daemonId);
    if (!status.authenticated) {
      console.log('Not authenticated. Run: ambient auth login');
    } else {
      console.log(`Authenticated as ${status.userEmail}`);
      console.log(`Device:          ${status.deviceLabel}`);
      console.log(`Organization:    ${status.organizationId}`);
      console.log(`Daemon ID:       ${daemonId.slice(0, 8)}…`);
    }
    process.exit(0);
  });

// ---------------------------------------------------------------------------
// identity — manage self-identity aliases (drop signals about yourself)
// ---------------------------------------------------------------------------

const identity = program
  .command('identity')
  .description('Manage self-identity aliases (your own emails — auto-logs are dropped)');

identity
  .command('add <email>')
  .description('Add an email as one of your own (signals matching it are dropped)')
  .action(async (email: string) => {
    const { addAlias } = await import('./leadspot/index.js');
    const { getDb } = await import('./storage/db.js');
    try {
      await addAlias(getDb(), email, 'user_added');
      console.log(`Added ${email} to self-identity.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to add alias: ${msg}`);
      process.exit(1);
    }
    process.exit(0);
  });

identity
  .command('remove <email>')
  .description('Remove an email from self-identity')
  .action(async (email: string) => {
    const { removeAlias } = await import('./leadspot/index.js');
    const { getDb } = await import('./storage/db.js');
    const removed = await removeAlias(getDb(), email);
    console.log(removed ? `Removed ${email} from self-identity.` : `${email} was not in self-identity.`);
    process.exit(0);
  });

identity
  .command('list')
  .description('Show all self-identity aliases (hash-only; raw emails are not stored)')
  .action(async () => {
    const { listAliases } = await import('./leadspot/index.js');
    const { getDb } = await import('./storage/db.js');
    const rows = listAliases(getDb());
    if (rows.length === 0) {
      console.log('No self-identity aliases. Add with: ambient identity add <email>');
    } else {
      console.log(`${rows.length} alias${rows.length === 1 ? '' : 'es'}:`);
      for (const row of rows) {
        const added = new Date(row.addedAt).toISOString();
        console.log(`  ${row.emailHash.slice(0, 12)}…  ${row.source.padEnd(11)}  added=${added}`);
      }
    }
    process.exit(0);
  });

// ---------------------------------------------------------------------------
// review — held signals (low confidence + pending toasts)
// ---------------------------------------------------------------------------

program
  .command('review')
  .description('Show held LeadSpot signals awaiting review')
  .option('--pending', 'Also show pending toasts (from ~/.ambient/pending_toasts.json)')
  .action(async (options: { pending?: boolean }) => {
    const { getDb } = await import('./storage/db.js');
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT id, extractor, summary, confidence
           FROM leadspot_signals
          WHERE state = 'held'
          ORDER BY observed_at DESC
          LIMIT 200`,
      )
      .all() as Array<{ id: string; extractor: string; summary: string; confidence: number }>;

    if (rows.length === 0) {
      console.log('No held signals.');
    } else {
      console.log(`${rows.length} held signal${rows.length === 1 ? '' : 's'}:`);
      console.log('');
      for (const r of rows) {
        const id = r.id.slice(0, 8);
        const summary = r.summary.length > 80 ? r.summary.slice(0, 77) + '…' : r.summary;
        console.log(`  ${id}  ${r.extractor.padEnd(18)}  conf=${r.confidence}  ${summary}`);
      }
    }

    if (options.pending === true) {
      try {
        const pathMod = await import('path');
        const fsMod = await import('fs');
        const { PATHS } = await import('./config/paths.js');
        const file = pathMod.join(PATHS.dataDir, 'pending_toasts.json');
        if (fsMod.existsSync(file)) {
          const raw = JSON.parse(fsMod.readFileSync(file, 'utf8')) as Array<{
            signal_id: string;
            summary: string;
            shown_at: number;
          }>;
          if (raw.length === 0) {
            console.log('\nNo pending toasts.');
          } else {
            console.log(`\n${raw.length} pending toast${raw.length === 1 ? '' : 's'}:`);
            for (const t of raw) {
              const age = Math.round((Date.now() - t.shown_at) / 1000);
              console.log(`  ${t.signal_id.slice(0, 8)}  age=${age}s  ${t.summary}`);
            }
          }
        } else {
          console.log('\nNo pending toasts file.');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`Failed to read pending toasts: ${msg}`);
      }
    }
    process.exit(0);
  });

// ---------------------------------------------------------------------------
// pause / resume — temporarily disable all daemon work
// ---------------------------------------------------------------------------

program
  .command('pause [duration]')
  .description('Pause the daemon: 1h | today | forever (default 1h)')
  .action(async (duration: string | undefined) => {
    const { setPause, parsePauseDuration } = await import('./state/pause.js');
    const { getDb } = await import('./storage/db.js');
    const arg = duration ?? '1h';
    let until;
    try {
      until = parsePauseDuration(arg);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    setPause(getDb(), until);
    if (until === 'forever') {
      console.log('Daemon paused indefinitely. Resume with: ambient resume');
    } else {
      console.log(`Daemon paused until ${new Date(until).toLocaleString()}.`);
    }
    process.exit(0);
  });

program
  .command('resume')
  .description('Resume the daemon if paused')
  .action(async () => {
    const { setPause } = await import('./state/pause.js');
    const { getDb } = await import('./storage/db.js');
    setPause(getDb(), null);
    console.log('Daemon resumed. Next polling cycle will run normally.');
    process.exit(0);
  });

// ---------------------------------------------------------------------------
// cost — today's Haiku spend + cap status
// ---------------------------------------------------------------------------

program
  .command('cost')
  .description("Show today's Haiku token usage and cap status")
  .action(async () => {
    const { getTodayUsage } = await import('./leadspot/index.js');
    const { getDb } = await import('./storage/db.js');
    const usage = getTodayUsage(getDb());
    const totalIn = usage.haiku_tokens_in;
    const totalOut = usage.haiku_tokens_out;
    const total = totalIn + totalOut;
    // 200k tokens/day for 7 AM - midnight coverage (~17 hours).
    // Haiku 4.5 pricing: ~$1/M in, ~$5/M out ≈ $1-1.50/day.
    const localBudget = 200_000;
    const pct = Math.round((total / localBudget) * 100);
    console.log(`Day: ${usage.day}`);
    console.log(`Haiku tokens: ${total.toLocaleString()} / ${localBudget.toLocaleString()} (${pct}%)`);
    console.log(`  in:  ${totalIn.toLocaleString()}`);
    console.log(`  out: ${totalOut.toLocaleString()}`);
    console.log(`Cost capped: ${usage.cost_capped_today === 1 ? 'yes' : 'no'}`);
    process.exit(0);
  });

// ---------------------------------------------------------------------------
// diagnostics — recent state + outbox + last errors
// ---------------------------------------------------------------------------

program
  .command('diagnostics')
  .description('Dump daemon state, recent errors, and last 10 promotion failures')
  .action(async () => {
    const { getDb } = await import('./storage/db.js');
    const { getPauseInfo } = await import('./state/pause.js');
    const db = getDb();

    // Daemon state values.
    const stateRows = db
      .prepare("SELECT key, value, updated_at FROM daemon_state ORDER BY key")
      .all() as Array<{ key: string; value: string; updated_at: string }>;
    console.log('Daemon state:');
    for (const r of stateRows) {
      console.log(`  ${r.key.padEnd(30)} = ${r.value}  (${r.updated_at})`);
    }

    const pause = getPauseInfo(db);
    console.log(
      `Pause: ${pause === null ? 'inactive' : pause.until === 'forever' ? 'forever' : new Date(pause.until).toISOString()}`,
    );

    // Outbox / promotion errors (last 10 failures).
    const outboxRows = db
      .prepare(
        `SELECT signal_id, attempts, last_error, next_attempt_at
           FROM leadspot_outbox
          WHERE last_error IS NOT NULL
          ORDER BY next_attempt_at DESC
          LIMIT 10`,
      )
      .all() as Array<{
        signal_id: string;
        attempts: number;
        last_error: string;
        next_attempt_at: number;
      }>;
    console.log(`\nOutbox errors (last ${outboxRows.length}):`);
    for (const r of outboxRows) {
      console.log(`  ${r.signal_id.slice(0, 8)}  attempts=${r.attempts}  ${r.last_error.slice(0, 100)}`);
    }

    // Recent error_events.
    const errors = db
      .prepare(
        `SELECT error_text, app_name, occurrence_count, last_seen
           FROM error_events
          ORDER BY last_seen DESC
          LIMIT 10`,
      )
      .all() as Array<{
        error_text: string;
        app_name: string | null;
        occurrence_count: number;
        last_seen: string;
      }>;
    console.log(`\nRecent error events (${errors.length}):`);
    for (const e of errors) {
      console.log(`  [${e.app_name ?? '-'}] ×${e.occurrence_count}  ${e.error_text.slice(0, 100)}  (${e.last_seen})`);
    }

    process.exit(0);
  });

// ---------------------------------------------------------------------------
// update — placeholder for Sparkle auto-update
// ---------------------------------------------------------------------------

program
  .command('update')
  .description('Update the daemon to the latest version')
  .action(() => {
    console.log('Auto-update via Sparkle is not yet implemented.');
    console.log('Run: npm install -g coder1-ambient@latest');
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
