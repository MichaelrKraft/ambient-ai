/**
 * Watches the privacy gate for outages. The gate fails closed, so a dead
 * OpenRouter key or an empty balance withholds every screen and the daily
 * recap silently comes out blank (2026-10-06 to 10-08: HTTP 402 for two days,
 * nothing alerted). Pure logic with an injectable clock; the daemon decides
 * how to deliver the alert.
 */
import type { GateResult } from './PrivacyGate.js';

type Counts = GateResult['counts'];

export type GateHealthEvent = { kind: 'alert'; message: string } | { kind: 'recovered' };

export interface GateHealthOptions {
  /** Cycles screening fewer entries than this carry no signal. */
  minScreens?: number;
  /** Fraction of screens failing the check that counts as an outage. */
  failRatio?: number;
  /** Bad cycles in a row before a non-billing failure alerts. */
  consecutive?: number;
  /** Minimum gap between alerts. */
  cooldownMs?: number;
  now?: () => number;
}

const BILLING_OR_AUTH = ['http_401', 'http_402', 'http_403', 'no_key'];

const HINTS: Record<string, string> = {
  http_402: 'OpenRouter account is out of credits. Add credits at https://openrouter.ai/settings/credits.',
  http_401: 'OpenRouter rejected the key. Check Keychain item ambient-daemon / openrouter-api-key.',
  http_403: 'OpenRouter refused the request. Check the key status and its credit limit.',
  no_key: 'AMBIENT_GATE_API_KEY is missing from the daemon environment.',
};

export class GateHealthMonitor {
  private readonly minScreens: number;
  private readonly failRatio: number;
  private readonly consecutive: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private streak = 0;
  private lastAlertAt: number | null = null;
  private down = false;

  constructor(options: GateHealthOptions = {}) {
    this.minScreens = options.minScreens ?? 5;
    this.failRatio = options.failRatio ?? 0.9;
    this.consecutive = options.consecutive ?? 2;
    this.cooldownMs = options.cooldownMs ?? 6 * 3_600_000;
    this.now = options.now ?? Date.now;
  }

  observe(counts: Counts, causes: Record<string, number>): GateHealthEvent | null {
    const total = counts.passed + counts.private + counts.error + counts.over_cap;
    if (total < this.minScreens) return null;

    if (counts.error / total < this.failRatio) {
      this.streak = 0;
      if (!this.down) return null;
      this.down = false;
      return { kind: 'recovered' };
    }

    this.streak++;
    const topCause = Object.entries(causes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';
    const fatal = BILLING_OR_AUTH.includes(topCause);
    if (!fatal && this.streak < this.consecutive) return null;

    this.down = true;
    const t = this.now();
    if (this.lastAlertAt !== null && t - this.lastAlertAt < this.cooldownMs) return null;
    this.lastAlertAt = t;

    const hint = HINTS[topCause] ?? 'Check network access to openrouter.ai and the daemon log.';
    return {
      kind: 'alert',
      message:
        `Ambient privacy gate is failing: ${counts.error} of ${total} screens could not be checked ` +
        `(cause: ${topCause}, ${this.streak} cycle(s) in a row). Every screen is being withheld, ` +
        `so there is no activity recap until this is fixed. ${hint}`,
    };
  }
}
