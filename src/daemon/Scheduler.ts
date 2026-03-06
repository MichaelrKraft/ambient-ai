/**
 * Scheduler — uses node-cron to trigger analysis cycles at a fixed interval.
 *
 * The cron task fires on a fixed-minute schedule (e.g., every 7 minutes).
 * If a previous tick is still running when the next one fires, it is skipped
 * with a warning rather than running two analyses in parallel.
 */

import cron from 'node-cron';
import { createLogger } from '../shared/logger.js';

export class Scheduler {
  private task: cron.ScheduledTask | null = null;
  private readonly log: ReturnType<typeof createLogger>;
  private readonly intervalMinutes: number;
  private onTickCallback: (() => Promise<void>) | null = null;
  private isRunning = false;

  constructor(intervalMinutes: number) {
    this.intervalMinutes = intervalMinutes;
    this.log = createLogger('scheduler');
  }

  /**
   * Register the callback that fires on every tick.
   * Must be called before start().
   */
  onTick(callback: () => Promise<void>): void {
    this.onTickCallback = callback;
  }

  /**
   * Start the scheduler. Converts the interval in minutes to a valid
   * 5-field cron expression and schedules the task.
   */
  start(): void {
    if (this.task !== null) {
      this.log.warn('Scheduler already started — ignoring duplicate start()');
      return;
    }

    const cronExpression = minutesToCron(this.intervalMinutes);
    this.log.info(
      `Starting scheduler (every ${this.intervalMinutes} minutes, cron: "${cronExpression}")`,
    );

    this.task = cron.schedule(cronExpression, async () => {
      if (this.isRunning) {
        this.log.warn('Previous tick still running — skipping this cycle');
        return;
      }

      this.isRunning = true;
      try {
        if (this.onTickCallback !== null) {
          await this.onTickCallback();
        }
      } catch (err) {
        this.log.error('Tick failed', err);
      } finally {
        this.isRunning = false;
      }
    });

    this.log.info(`Scheduler started (every ${this.intervalMinutes} minutes)`);
  }

  /** Stop the scheduled task. Safe to call when already stopped. */
  stop(): void {
    if (this.task !== null) {
      this.task.stop();
      this.task = null;
      this.log.info('Scheduler stopped');
    }
  }
}

/**
 * Convert an interval in minutes to a 5-field cron expression.
 *
 * Standard divisors of 60 produce clean `* /N` expressions.
 * For non-divisor intervals (e.g., 7), we use `* /N` anyway — node-cron
 * treats `* /7` as "every 7 minutes starting at minute 0", which gives
 * a consistent cadence aligned to the clock hour.
 *
 * Examples:
 *   5  → "* /5 * * * *"
 *   7  → "* /7 * * * *"
 *   10 → "* /10 * * * *"
 *   15 → "* /15 * * * *"
 */
function minutesToCron(minutes: number): string {
  const clamped = Math.max(1, Math.floor(minutes));
  return `*/${clamped} * * * *`;
}
