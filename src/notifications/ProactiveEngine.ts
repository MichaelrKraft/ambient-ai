/**
 * ProactiveEngine — scans the ambient store after each analysis cycle and
 * fires notifications when conditions warrant user attention.
 *
 * Current checks:
 *   - checkStuckErrors: alerts when an unresolved error has persisted >90 min
 *     and no duplicate alert has been sent within the last 3 hours.
 *
 * Only one notification fires per checkAndNotify() call to prevent spam.
 * Each fired notification is recorded in the notifications table for dedup.
 */

import { createLogger } from '../shared/logger.js';
import { nowISO } from '../shared/time.js';
import type { AmbientConfig } from '../config/index.js';
import {
  getUnresolvedErrors,
  getRecentNotifications,
  markErrorNotified,
  insertNotification,
  type ErrorEvent,
} from '../storage/AmbientStore.js';
import { sendNotification } from './channels.js';

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class ProactiveEngine {
  private readonly log = createLogger('proactive');
  private readonly config: AmbientConfig;

  constructor(config: AmbientConfig) {
    this.config = config;
  }

  /**
   * Run all proactive checks. Call this after each daemon analysis cycle.
   * Returns the number of notifications that were fired.
   */
  async checkAndNotify(): Promise<number> {
    let fired = 0;
    fired += await this.checkStuckErrors();
    // Future: fired += await this.checkGoalProgress();
    // Future: fired += await this.checkSessionLength();
    return fired;
  }

  // ---------------------------------------------------------------------------
  // Private checks
  // ---------------------------------------------------------------------------

  /**
   * Checks for errors unresolved for >90 minutes that haven't already been
   * notified. Sends at most one notification per call to avoid spam.
   *
   * Returns 1 if a notification was sent, 0 otherwise.
   */
  private async checkStuckErrors(): Promise<number> {
    const STUCK_THRESHOLD_MINUTES = 90;
    const DEDUP_WINDOW_HOURS = 3;

    let stuck: ErrorEvent[];
    try {
      stuck = getUnresolvedErrors(STUCK_THRESHOLD_MINUTES);
    } catch (err) {
      this.log.warn('Failed to query unresolved errors', { error: String(err) });
      return 0;
    }

    if (stuck.length === 0) return 0;

    // Load recent notifications once for dedup checks across all stuck errors
    let recentNotifications: ReturnType<typeof getRecentNotifications>;
    try {
      recentNotifications = getRecentNotifications(DEDUP_WINDOW_HOURS);
    } catch (err) {
      this.log.warn('Failed to query recent notifications', { error: String(err) });
      return 0;
    }

    for (const error of stuck) {
      const durationMs = Date.now() - new Date(error.first_seen).getTime();
      const durationH = (durationMs / 3_600_000).toFixed(1);

      // Dedup: skip if we already sent an alert mentioning this error text
      const errorPrefix = error.error_text.slice(0, 50);
      const alreadyNotified = recentNotifications.some((n) =>
        n.content.includes(errorPrefix),
      );

      if (alreadyNotified) {
        this.log.debug('Skipping duplicate notification', { error: errorPrefix });
        continue;
      }

      const appLabel = error.app_name ?? 'unknown';
      const channel = this.config.telegramBotToken ? 'both' : 'system';
      const message =
        `\u{1F50D} *Stuck for ${durationH}h:* ${error.error_text}\n` +
        `App: ${appLabel} | Seen ${error.occurrence_count}x`;

      try {
        await sendNotification(
          {
            title: 'ambient: Stuck Error',
            message,
            channel,
            urgency: 'normal',
          },
          {
            telegramBotToken: this.config.telegramBotToken,
            telegramChatId: this.config.telegramChatId,
          },
        );
      } catch (err) {
        this.log.warn('Failed to send stuck-error notification', { error: String(err) });
        return 0;
      }

      // Mark error as notified so it won't fire again until resolved
      try {
        markErrorNotified(error.id);
      } catch (err) {
        this.log.warn('Failed to mark error as notified', { id: error.id, error: String(err) });
      }

      // Record in notifications table for dedup in future cycles
      try {
        insertNotification({
          triggered_at: nowISO(),
          content: message,
          channel,
        });
      } catch (err) {
        this.log.warn('Failed to insert notification record', { error: String(err) });
      }

      this.log.info('Stuck-error notification sent', {
        errorId: error.id,
        durationH,
        app: appLabel,
        channel,
      });

      // Only one notification per cycle to prevent alert flooding
      return 1;
    }

    return 0;
  }
}
