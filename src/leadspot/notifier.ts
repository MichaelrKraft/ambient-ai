/**
 * macOS toast notifier for the 60s "click to drop" flow (§2.2).
 *
 * Source-of-truth: the 60s timer in promote.ts. The notifier is best-effort
 * UX. If the click callback misfires (node-notifier is flaky on Big Sur+),
 * the user can still drop the signal via `ambient review --pending`.
 *
 * Two implementations:
 *  - MacNotifier: native notification via node-notifier with click feedback.
 *    Falls back to `osascript` if node-notifier emits no click event within
 *    the hold window.
 *  - NoopNotifier: tests + headless environments.
 *
 * The pending-toasts log lives at `~/.ambient/pending_toasts.json` and is
 * purely advisory — promote.ts owns truth.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { PATHS } from '../config/paths.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('leadspot:notifier');

export interface NotifierArgs {
  signalId: string;
  contactId: string | null;
  summary: string;
  sourceApp: string;
  onCancel: (signalId: string) => Promise<void>;
}

export interface Notifier {
  show(args: NotifierArgs): Promise<void>;
}

interface PendingToast {
  signal_id: string;
  contact_id: string | null;
  summary: string;
  source_app: string;
  shown_at: number;
}

const PENDING_TOASTS_PATH = path.join(PATHS.dataDir, 'pending_toasts.json');

function readPending(): PendingToast[] {
  try {
    const raw = fs.readFileSync(PENDING_TOASTS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as PendingToast[];
    return [];
  } catch {
    return [];
  }
}

function writePending(rows: PendingToast[]): void {
  try {
    fs.mkdirSync(path.dirname(PENDING_TOASTS_PATH), { recursive: true });
    fs.writeFileSync(PENDING_TOASTS_PATH, JSON.stringify(rows, null, 2), 'utf8');
  } catch (err) {
    log.warn('Failed to write pending_toasts.json (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function appendPending(toast: PendingToast): void {
  const rows = readPending();
  rows.push(toast);
  // Cap at 200 entries to avoid runaway growth if the daemon orphans toasts.
  while (rows.length > 200) rows.shift();
  writePending(rows);
}

function removePending(signalId: string): void {
  const rows = readPending().filter((r) => r.signal_id !== signalId);
  writePending(rows);
}

export class NoopNotifier implements Notifier {
  async show(_args: NotifierArgs): Promise<void> {
    // Intentionally empty.
  }
}

/**
 * Native macOS notification. Best-effort click feedback via node-notifier,
 * with osascript as a no-click fallback.
 */
export class MacNotifier implements Notifier {
  async show(args: NotifierArgs): Promise<void> {
    appendPending({
      signal_id: args.signalId,
      contact_id: args.contactId,
      summary: args.summary,
      source_app: args.sourceApp,
      shown_at: Date.now(),
    });

    let clicked = false;
    try {
      // Lazy-load to keep cold start cheap and so NoopNotifier callers in
      // tests don't pay the import cost.
      const notifier = (await import('node-notifier')).default;
      notifier.notify(
        {
          title: 'LeadSpot · auto-logged',
          message: `${args.summary}\nClick to drop.`,
          wait: true,
          timeout: 60,
          actions: ['Drop'],
        },
        (err: unknown, response: string | undefined) => {
          if (err !== null && err !== undefined) {
            log.warn('node-notifier callback returned error', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          if (typeof response === 'string'
            && (response === 'activate' || response.toLowerCase() === 'drop')
          ) {
            clicked = true;
            args.onCancel(args.signalId).catch((cancelErr) => {
              log.error('onCancel from notifier failed', cancelErr);
            });
          }
        },
      );
    } catch (err) {
      log.warn('node-notifier unavailable; falling back to osascript', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.osascriptFallback(args.summary);
    }

    // We don't await the click — promote.ts holds the 60s timer that's the
    // real source of truth. The pending file tracks unobserved toasts so the
    // user can clear them via CLI even if node-notifier never fires.
    setTimeout(() => {
      if (!clicked) removePending(args.signalId);
    }, 60_000);
  }

  private osascriptFallback(summary: string): void {
    // SECURITY: `summary` is OCR/contact-derived and untrusted. Build the
    // AppleScript with JSON.stringify (safe string quoting) and run it via
    // execFile — which does NOT spawn a shell — so the content can never be
    // interpreted as a shell command (was a command-injection vector when
    // interpolated into an `osascript -e '...'` exec() string).
    const msg = summary.slice(0, 200);
    const script =
      `display notification ${JSON.stringify(msg)} ` +
      `with title ${JSON.stringify('LeadSpot · auto-logged')}`;
    execFile('osascript', ['-e', script], (err) => {
      if (err !== null) {
        log.warn('osascript notification failed (non-fatal)', {
          error: err.message,
        });
      }
    });
  }
}
