/**
 * In-memory access-token cache with single-flight refresh.
 *
 * Why this layer exists:
 *  - Access tokens have a 15-minute TTL; the daemon makes many calls per
 *    minute. We cache so we're not refreshing on every request.
 *  - Multiple concurrent callers must NOT each trigger their own refresh
 *    (would burn rate-limit + race the rotation grace window). Single-flight
 *    means: while a refresh is in flight, all later getToken() calls await
 *    the same Promise.
 *  - The "60s grace" rule: if /auth/refresh returns refresh_token="", the
 *    server is telling us our generation is still valid (the rotation race
 *    fix from §2.4). We keep using the existing refresh token in Keychain.
 *
 * NOT covered here (callers must handle):
 *  - Persisting the rotated refresh token to Keychain. We invoke a callback
 *    `persistRefreshToken` so the keychain module owns the write.
 *  - Surfacing AuthExpiredError to the user. We just throw it.
 */
import { createLogger } from '../shared/logger.js';
import { LeadSpotClient } from './client.js';
import { AuthError, AuthExpiredError } from './errors.js';
import { loadRefreshToken, saveRefreshToken } from './keychain.js';

const log = createLogger('leadspot:tokens');

/** Refresh `expires_in` seconds before actual expiry to avoid clock-edge 401s. */
const REFRESH_BUFFER_MS = 60_000;

interface CachedToken {
  token: string;
  /** Wall-clock ms when this token should be considered expired. */
  expiresAtMs: number;
}

export interface AccessTokenCacheOptions {
  daemonId: string;
  /**
   * The HTTP client used solely to call POST /api/daemon/auth/refresh.
   * Must be constructed with `getAccessToken: () => "" ` or noAuth — but
   * since we only call refreshAccessToken (which is noAuth), any client
   * works.
   */
  client: LeadSpotClient;
}

export class AccessTokenCache {
  private readonly daemonId: string;
  private readonly client: LeadSpotClient;
  private cached: CachedToken | null = null;
  private inflight: Promise<string> | null = null;

  constructor(opts: AccessTokenCacheOptions) {
    this.daemonId = opts.daemonId;
    this.client = opts.client;
  }

  /**
   * Get a valid access token. Refreshes if expired, or always if forceRefresh.
   * Concurrent callers share one in-flight refresh.
   */
  async getToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.cached !== null && this.cached.expiresAtMs > Date.now()) {
      return this.cached.token;
    }

    if (this.inflight !== null) {
      // A refresh is already underway — every other caller awaits the same
      // Promise. This is the "single-flight" guarantee.
      return await this.inflight;
    }

    this.inflight = this.refresh().finally(() => {
      this.inflight = null;
    });

    return await this.inflight;
  }

  /** Drop the cached token. Next getToken() will refresh. */
  invalidate(): void {
    this.cached = null;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async refresh(): Promise<string> {
    const refreshToken = await loadRefreshToken(this.daemonId);
    if (refreshToken === null) {
      throw new AuthExpiredError(
        'No refresh token in Keychain — run `ambient auth login`',
      );
    }

    let res;
    try {
      res = await this.client.refreshAccessToken(refreshToken);
    } catch (err) {
      if (err instanceof AuthError) {
        // 401/403 from /refresh: this refresh token is dead. Clear cache so
        // the next call triggers a re-load (which will also fail until
        // re-auth) and surface AuthExpiredError so the caller can prompt.
        this.cached = null;
        throw new AuthExpiredError(
          'Refresh token rejected — run `ambient auth login` again',
        );
      }
      throw err;
    }

    // 60s grace race fix: empty refresh_token means "your generation is
    // still current — keep what you have." Don't overwrite Keychain.
    if (res.refresh_token.length > 0 && res.refresh_token !== refreshToken) {
      try {
        await saveRefreshToken(this.daemonId, res.refresh_token);
      } catch (err) {
        // We have a working access token but couldn't persist the new
        // refresh. Log loudly; if we crash before next refresh the user
        // re-auths. Don't fail the original request.
        log.error('Failed to persist rotated refresh token to Keychain', err);
      }
    }

    const expiresAtMs =
      Date.now() + Math.max(0, res.expires_in * 1000 - REFRESH_BUFFER_MS);
    this.cached = { token: res.access_token, expiresAtMs };
    log.debug('Access token refreshed', {
      expiresInSec: res.expires_in,
      rotated: res.refresh_token.length > 0,
    });
    return res.access_token;
  }
}
