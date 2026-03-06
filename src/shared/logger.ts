import fs from 'fs';
import path from 'path';
import { PATHS } from '../config/paths.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const minLevel: Level =
  (process.env.LOG_LEVEL as Level | undefined) ?? 'info';

function shouldLog(level: Level): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

function format(level: Level, context: string, message: string): string {
  const ts = new Date().toISOString();
  return `${ts} [${level.toUpperCase().padEnd(5)}] [${context}] ${message}`;
}

function writeToFile(line: string): void {
  try {
    fs.mkdirSync(path.dirname(PATHS.log), { recursive: true });
    fs.appendFileSync(PATHS.log, line + '\n');
  } catch {
    // Non-fatal — we never crash because of logging failures
  }
}

export function createLogger(context: string) {
  return {
    debug(message: string, data?: unknown): void {
      if (!shouldLog('debug')) return;
      const line = format('debug', context, message);
      if (data !== undefined) {
        process.stdout.write(line + ' ' + JSON.stringify(data) + '\n');
      } else {
        process.stdout.write(line + '\n');
      }
    },

    info(message: string, data?: unknown): void {
      if (!shouldLog('info')) return;
      const line = format('info', context, message);
      const full = data !== undefined ? line + ' ' + JSON.stringify(data) : line;
      process.stdout.write(full + '\n');
      writeToFile(full);
    },

    warn(message: string, data?: unknown): void {
      if (!shouldLog('warn')) return;
      const line = format('warn', context, message);
      const full = data !== undefined ? line + ' ' + JSON.stringify(data) : line;
      process.stderr.write(full + '\n');
      writeToFile(full);
    },

    error(message: string, err?: unknown): void {
      if (!shouldLog('error')) return;
      const errStr =
        err instanceof Error
          ? `${err.message}\n${err.stack ?? ''}`
          : JSON.stringify(err);
      const line = format('error', context, `${message} — ${errStr}`);
      process.stderr.write(line + '\n');
      writeToFile(line);
    },
  };
}
