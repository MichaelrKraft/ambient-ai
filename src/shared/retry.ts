import { createLogger } from './logger.js';

const log = createLogger('retry');

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  shouldRetry?: (err: unknown) => boolean;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs = 30_000, shouldRetry } = options;

  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      if (shouldRetry && !shouldRetry(err)) {
        throw err;
      }

      if (attempt === maxAttempts) break;

      // Exponential backoff with jitter
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const jitter = Math.random() * delay * 0.1;
      const wait = Math.round(delay + jitter);

      log.warn(`Attempt ${attempt}/${maxAttempts} failed, retrying in ${wait}ms`, {
        error: lastErr instanceof Error ? lastErr.message : String(lastErr),
      });

      await sleep(wait);
    }
  }

  throw lastErr;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
