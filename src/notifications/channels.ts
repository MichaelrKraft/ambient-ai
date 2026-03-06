/**
 * Notification channels — system (node-notifier) and Telegram (telegraf).
 *
 * Both send functions are non-fatal: failures are logged as warnings so a
 * broken notification path never crashes the daemon.
 *
 * sendTelegramMessage creates a fresh Telegraf instance per call (outbound-
 * only pattern) and stops it in the finally block to avoid stale bot state.
 */

import notifier from 'node-notifier';
import { Telegraf } from 'telegraf';
import { createLogger } from '../shared/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotificationChannel = 'system' | 'telegram' | 'both';

export interface NotificationPayload {
  title: string;
  message: string;
  channel: NotificationChannel;
  urgency?: 'low' | 'normal' | 'high';
}

// ---------------------------------------------------------------------------
// System notification (node-notifier)
// ---------------------------------------------------------------------------

/**
 * Sends a macOS/Linux system notification via node-notifier.
 * Always resolves — notification failure is non-fatal.
 */
export async function sendSystemNotification(
  title: string,
  message: string,
): Promise<void> {
  const log = createLogger('notifier');

  return new Promise((resolve) => {
    // Cast to unknown then to Parameters[0] so we can pass the macOS-specific
    // `appID` field (required on Monterey+ to avoid a "null" sender label)
    // without the @types/node-notifier definitions rejecting it.
    const options = {
      title,
      message,
      appID: 'ambient',
      timeout: 10,
    } as unknown as Parameters<typeof notifier.notify>[0];

    notifier.notify(
      options,
      (err) => {
        if (err) {
          log.warn('System notification failed', { error: String(err) });
        }
        resolve(); // Always resolve — notification failure is non-fatal
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Telegram notification (outbound-only, fresh instance per call)
// ---------------------------------------------------------------------------

/**
 * Sends a Markdown-formatted message to a Telegram chat.
 * Creates a new Telegraf instance per call and stops it afterwards
 * to avoid stale bot issues across long-running daemon cycles.
 */
export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  message: string,
): Promise<void> {
  const log = createLogger('telegram');
  const bot = new Telegraf(botToken);

  try {
    await bot.telegram.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (err) {
    log.warn('Telegram send failed', { error: String(err) });
  } finally {
    bot.stop(); // Clean up bot instance regardless of success or failure
  }
}

// ---------------------------------------------------------------------------
// Unified send function
// ---------------------------------------------------------------------------

/**
 * Routes a notification to the configured channel(s).
 * Telegram is skipped silently if botToken or chatId is absent.
 */
export async function sendNotification(
  payload: NotificationPayload,
  config: { telegramBotToken?: string; telegramChatId?: string },
): Promise<void> {
  const log = createLogger('notifications');

  if (payload.channel === 'system' || payload.channel === 'both') {
    await sendSystemNotification(payload.title, payload.message);
  }

  if (
    (payload.channel === 'telegram' || payload.channel === 'both') &&
    config.telegramBotToken &&
    config.telegramChatId
  ) {
    await sendTelegramMessage(
      config.telegramBotToken,
      config.telegramChatId,
      payload.message,
    );
  }

  log.info('Notification sent', { channel: payload.channel, title: payload.title });
}
