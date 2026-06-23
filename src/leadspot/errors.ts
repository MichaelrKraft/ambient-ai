/**
 * Concrete error classes for the LeadSpot module.
 *
 * Throw these from network/auth code paths so callers can discriminate
 * via `instanceof`. Generic Error is reserved for programmer mistakes.
 */

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Thrown by AccessTokenCache when refresh fails with 401 — the user must
 * re-run `ambient auth login`. Distinct from AuthError so callers can
 * distinguish "needs re-auth" from "auth misconfigured."
 */
export class AuthExpiredError extends AuthError {
  constructor(message = 'Refresh token rejected; daemon must re-authenticate') {
    super(message);
    this.name = 'AuthExpiredError';
  }
}

/**
 * Thrown by LeadSpotClient when the network layer fails (DNS, TCP, TLS,
 * timeout) after all retries are exhausted. 5xx responses also map here.
 */
export class NetworkError extends Error {
  readonly status?: number;
  readonly cause?: unknown;
  /** Server-suggested wait in seconds (from a 429 Retry-After header). */
  readonly retryAfterSec?: number;
  constructor(
    message: string,
    opts: { status?: number; cause?: unknown; retryAfterSec?: number } = {},
  ) {
    super(message);
    this.name = 'NetworkError';
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.cause !== undefined) this.cause = opts.cause;
    if (opts.retryAfterSec !== undefined) this.retryAfterSec = opts.retryAfterSec;
  }
}

/**
 * Thrown when the cloud responds 426 (daemon version too old). The daemon
 * must surface a banner and stop promoting until updated.
 */
export class VersionMismatchError extends Error {
  readonly minVersion?: string;
  readonly currentVersion?: string;
  constructor(message: string, opts: { minVersion?: string; currentVersion?: string } = {}) {
    super(message);
    this.name = 'VersionMismatchError';
    if (opts.minVersion !== undefined) this.minVersion = opts.minVersion;
    if (opts.currentVersion !== undefined) this.currentVersion = opts.currentVersion;
  }
}
