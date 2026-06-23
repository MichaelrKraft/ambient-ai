/**
 * ProactiveEngine — scans the ambient store after each analysis cycle and
 * fires notifications when conditions warrant user attention.
 *
 * Checks, in PRIORITY order (highest first):
 *   1. checkUpcomingMeetings — meeting starting soon, with a prep brief
 *      (Phase 4; only runs when config.calendar.enabled).
 *   2. checkOverdueTasks    — a digest of open tasks past their due date.
 *   3. checkStuckErrors     — an unresolved error persisting >90 min.
 *   4. checkGoalProgress    — a goal nearing its target date with no recent
 *      progress.
 *
 * At most ONE notification fires per checkAndNotify() call (true single-fire,
 * enforced by the `if (fired === 0)` chain) so a backlog never floods the user.
 * Each fired notification embeds a stable dedup token in its content
 * (`[task-overdue:<date>]`, `[error:<prefix>]`, `[goal:<id>]`, `[mtg:<id>]`)
 * and is recorded in the notifications table; subsequent cycles skip a token
 * already seen inside its dedup window.
 *
 * Config is passed in per-call (not cached at construction) so changes made via
 * `saveConfig` take effect on the next cycle without a daemon restart.
 */

import { createLogger } from '../shared/logger.js';
import { nowISO } from '../shared/time.js';
import type { AmbientConfig } from '../config/index.js';
import {
  getUnresolvedErrors,
  getRecentNotifications,
  getOverdueTasks,
  getGoalsNeedingNudge,
  markErrorNotified,
  insertNotification,
  localDateString,
  type ErrorEvent,
} from '../storage/AmbientStore.js';
import { sendNotification, type NotificationChannel } from './channels.js';

export class ProactiveEngine {
  private readonly log = createLogger('proactive');

  /**
   * Run all proactive checks in priority order. Call after each analysis cycle.
   * Returns the number of notifications fired (0 or 1).
   */
  async checkAndNotify(config: AmbientConfig): Promise<number> {
    let fired = 0;
    // Priority 1 (imminent meeting) is added in Phase 4 — checkUpcomingMeetings.
    if (fired === 0) fired += await this.checkOverdueTasks(config);
    if (fired === 0) fired += await this.checkStuckErrors(config);
    if (fired === 0) fired += await this.checkGoalProgress(config);
    return fired;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Channel to use given current config: Telegram + system when a token is set. */
  private channelFor(config: AmbientConfig): NotificationChannel {
    return config.telegramBotToken ? 'both' : 'system';
  }

  /** True if a notification containing `token` was sent within `hoursBack`. */
  private recentlyNotified(token: string, hoursBack: number): boolean {
    try {
      return getRecentNotifications(hoursBack).some((n) =>
        n.content.includes(token),
      );
    } catch (err) {
      this.log.warn('Failed to query recent notifications', { error: String(err) });
      // Fail closed: assume notified, so a query blip never causes a storm.
      return true;
    }
  }

  /** Sends a notification and records it (with its dedup token) in the store. */
  private async fire(
    config: AmbientConfig,
    title: string,
    message: string,
  ): Promise<void> {
    const channel = this.channelFor(config);
    await sendNotification(
      { title, message, channel, urgency: 'normal' },
      {
        telegramBotToken: config.telegramBotToken,
        telegramChatId: config.telegramChatId,
      },
    );
    try {
      insertNotification({ triggered_at: nowISO(), content: message, channel });
    } catch (err) {
      this.log.warn('Failed to insert notification record', { error: String(err) });
    }
  }

  // ---------------------------------------------------------------------------
  // Checks
  // ---------------------------------------------------------------------------

  /**
   * Overdue open tasks → one daily digest (not one alert per task), deduped on
   * a per-day token so a backlog of 20 overdue tasks produces a single ping.
   */
  private async checkOverdueTasks(config: AmbientConfig): Promise<number> {
    let overdue;
    try {
      overdue = getOverdueTasks();
    } catch (err) {
      this.log.warn('Failed to query overdue tasks', { error: String(err) });
      return 0;
    }
    if (overdue.length === 0) return 0;

    // Daily cap: one overdue digest per calendar day.
    const token = `[task-overdue:${localDateString()}]`;
    if (this.recentlyNotified(token, 24)) return 0;

    const shown = overdue.slice(0, 5);
    const lines = shown.map((t) => `• ${t.content} (due ${t.due_date})`);
    const more = overdue.length - shown.length;
    if (more > 0) lines.push(`…and ${more} more`);

    const message =
      `\u{1F4CB} *${overdue.length} overdue task${overdue.length === 1 ? '' : 's'}:*\n` +
      `${lines.join('\n')}\n${token}`;

    await this.fire(config, 'ambient: Overdue Tasks', message);
    this.log.info('Overdue-task digest sent', { count: overdue.length });
    return 1;
  }

  /**
   * Errors unresolved for >90 min that haven't already been notified.
   * Deduped on an error-text-prefix token.
   */
  private async checkStuckErrors(config: AmbientConfig): Promise<number> {
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

    for (const error of stuck) {
      const errorPrefix = error.error_text.slice(0, 50);
      const token = `[error:${errorPrefix}]`;
      if (this.recentlyNotified(token, DEDUP_WINDOW_HOURS)) {
        this.log.debug('Skipping duplicate error notification', { error: errorPrefix });
        continue;
      }

      const durationH = ((Date.now() - new Date(error.first_seen).getTime()) / 3_600_000).toFixed(1);
      const appLabel = error.app_name ?? 'unknown';
      const message =
        `\u{1F50D} *Stuck for ${durationH}h:* ${error.error_text}\n` +
        `App: ${appLabel} | Seen ${error.occurrence_count}x\n${token}`;

      await this.fire(config, 'ambient: Stuck Error', message);

      try {
        markErrorNotified(error.id);
      } catch (err) {
        this.log.warn('Failed to mark error as notified', { id: error.id, error: String(err) });
      }

      this.log.info('Stuck-error notification sent', { errorId: error.id, durationH, app: appLabel });
      return 1; // one alert per cycle
    }

    return 0;
  }

  /**
   * A goal nearing its target date with no progress logged recently → one
   * nudge, deduped per goal on a 3-day window.
   */
  private async checkGoalProgress(config: AmbientConfig): Promise<number> {
    let goals;
    try {
      goals = getGoalsNeedingNudge(7, 3);
    } catch (err) {
      this.log.warn('Failed to query goals needing nudge', { error: String(err) });
      return 0;
    }
    if (goals.length === 0) return 0;

    for (const goal of goals) {
      const token = `[goal:${goal.id}]`;
      if (this.recentlyNotified(token, 72)) continue;

      const due = goal.target_date ? ` (target ${goal.target_date})` : '';
      const message =
        `\u{1F3AF} *No recent progress on a goal:*\n${goal.title}${due}\n${token}`;

      await this.fire(config, 'ambient: Goal Nudge', message);
      this.log.info('Goal-progress nudge sent', { goalId: goal.id });
      return 1;
    }

    return 0;
  }
}
