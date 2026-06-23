/**
 * HTTP client for the LeadSpot.AI daemon API.
 *
 * Responsibilities:
 *  - Add Bearer auth (delegated to a getAccessToken callback so the cache
 *    layer owns refresh logic; this client never touches Keychain).
 *  - Add User-Agent + X-Daemon-Version on every request.
 *  - Retry transient network failures 3x with exp backoff (200/800/3200ms).
 *  - On 401: trigger one re-fetch via the callback, then retry once.
 *    If that also 401s, propagate as AuthError.
 *  - On 426: throw VersionMismatchError (caller suspends promotion).
 *  - On 4xx other: throw NetworkError with status set.
 *  - On 5xx: count toward retry budget, then throw NetworkError.
 */
import { createLogger } from '../shared/logger.js';
import { AuthError, NetworkError, VersionMismatchError } from './errors.js';
import type {
  ContactSyncResponse,
  CostIncrementRequest,
  CostIncrementResponse,
  PostSignalRequest,
  PostSignalResponse,
  RefreshResponse,
  TombstonePage,
  VersionResponse,
} from './types.js';

const log = createLogger('leadspot:client');

const RETRY_DELAYS_MS = [200, 800, 3200] as const;

export type GetAccessToken = (forceRefresh?: boolean) => Promise<string>;

export interface LeadSpotClientOptions {
  baseUrl: string;
  daemonId: string;
  daemonVersion: string;
  getAccessToken: GetAccessToken;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
}

interface RequestOptions {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
  /** Skip Bearer auth (for /version, OAuth token exchange). */
  noAuth?: boolean;
}

export class LeadSpotClient {
  private readonly baseUrl: string;
  private readonly daemonId: string;
  private readonly daemonVersion: string;
  private readonly getAccessToken: GetAccessToken;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: LeadSpotClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.daemonId = opts.daemonId;
    this.daemonVersion = opts.daemonVersion;
    this.getAccessToken = opts.getAccessToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async getVersion(): Promise<VersionResponse> {
    return await this.request<VersionResponse>({
      method: 'GET',
      path: '/api/version',
      noAuth: true,
    });
  }

  async syncContacts(since: string | null): Promise<ContactSyncResponse> {
    const qs = new URLSearchParams({ limit: '500' });
    if (since !== null) qs.set('since', since);
    return await this.request<ContactSyncResponse>({
      method: 'GET',
      path: `/api/contacts/sync?${qs.toString()}`,
    });
  }

  async incrementCost(payload: CostIncrementRequest): Promise<CostIncrementResponse> {
    return await this.request<CostIncrementResponse>({
      method: 'POST',
      path: '/api/daemon/cost/increment',
      body: payload,
    });
  }

  /**
   * Direct refresh-token exchange. Used by AccessTokenCache; not for general
   * call sites. noAuth because the refresh token IS the credential.
   */
  async refreshAccessToken(refreshToken: string): Promise<RefreshResponse> {
    return await this.request<RefreshResponse>({
      method: 'POST',
      path: '/api/daemon/auth/refresh',
      body: { refresh_token: refreshToken },
      noAuth: true,
    });
  }

  /**
   * Promote a signal to the cloud. Idempotent on `idempotency_key`:
   * a 409 means we've already POSTed this row; treat as success — the
   * cloud returns the existing row's state.
   */
  async postSignal(payload: PostSignalRequest): Promise<PostSignalResponse> {
    try {
      return await this.request<PostSignalResponse>({
        method: 'POST',
        path: '/api/signals',
        body: payload,
      });
    } catch (err) {
      if (err instanceof NetworkError && err.status === 409) {
        // Cloud may include the existing row's body on 409; if not, synthesize
        // a "promoted" response so the caller advances state.
        const detail = err.message;
        const idMatch = /"signal_id"\s*:\s*"([^"]+)"/.exec(detail);
        const contactMatch = /"contact_id"\s*:\s*"([^"]+)"/.exec(detail);
        const stateMatch = /"state"\s*:\s*"([^"]+)"/.exec(detail);
        return {
          signal_id: idMatch?.[1] ?? '',
          contact_id: contactMatch?.[1] ?? null,
          state: stateMatch?.[1] ?? 'promoted',
        };
      }
      throw err;
    }
  }

  /**
   * Pull the next page of tombstones since the cursor. Returns next_since=null
   * when the page is the last one.
   */
  async getTombstones(since: string | null): Promise<TombstonePage> {
    const qs = new URLSearchParams({ limit: '500' });
    if (since !== null) qs.set('since', since);
    return await this.request<TombstonePage>({
      method: 'GET',
      path: `/api/tombstones?${qs.toString()}`,
    });
  }

  // -------------------------------------------------------------------------
  // Internal: HTTP with retries + 401 single-refresh
  // -------------------------------------------------------------------------

  private async request<T>(opts: RequestOptions): Promise<T> {
    const url = `${this.baseUrl}${opts.path}`;
    let auth401Retried = false;
    let networkAttempt = 0;

    // Loop handles two distinct retry kinds: transient network/5xx (with backoff)
    // and a single 401-refresh-and-retry. Both are bounded.
    while (true) {
      const headers: Record<string, string> = {
        'User-Agent': `LeadSpotAmbient/${this.daemonVersion}`,
        'X-Daemon-Version': this.daemonVersion,
        'X-Daemon-Id': this.daemonId,
      };
      if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
      if (!opts.noAuth) {
        const token = await this.getAccessToken(false);
        headers.Authorization = `Bearer ${token}`;
      }

      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: opts.method,
          headers,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });
      } catch (err) {
        // Genuine network failure: DNS, TCP, TLS, timeout.
        if (networkAttempt < RETRY_DELAYS_MS.length) {
          const delay = RETRY_DELAYS_MS[networkAttempt];
          networkAttempt += 1;
          log.warn(`Network error on ${opts.method} ${opts.path}; retrying in ${delay}ms`, {
            attempt: networkAttempt,
            error: err instanceof Error ? err.message : String(err),
          });
          await sleep(delay);
          continue;
        }
        throw new NetworkError(
          `Request to ${opts.path} failed after ${RETRY_DELAYS_MS.length} retries`,
          { cause: err },
        );
      }

      // 426 means the daemon is too old. Surface immediately; no retry.
      if (res.status === 426) {
        const body = await readBodySafe(res);
        throw new VersionMismatchError(
          `Daemon version ${this.daemonVersion} rejected by cloud (426)`,
          {
            minVersion: typeof body === 'object' && body && 'min_daemon_version' in body
              ? String((body as { min_daemon_version: unknown }).min_daemon_version)
              : undefined,
          },
        );
      }

      // Single-flight 401: force a fresh access token, retry once.
      if (res.status === 401 && !opts.noAuth && !auth401Retried) {
        auth401Retried = true;
        log.warn(`401 on ${opts.method} ${opts.path}; forcing access-token refresh`);
        try {
          await this.getAccessToken(true);
        } catch (err) {
          // Refresh itself failed — propagate as AuthError.
          if (err instanceof AuthError) throw err;
          throw new AuthError(
            `Auth refresh failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        continue;
      }

      // 5xx — transient on the server side; retry within budget.
      if (res.status >= 500 && networkAttempt < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[networkAttempt];
        networkAttempt += 1;
        log.warn(`${res.status} on ${opts.method} ${opts.path}; retrying in ${delay}ms`);
        await sleep(delay);
        continue;
      }

      if (!res.ok) {
        const body = await readBodySafe(res);
        const detail = typeof body === 'string' ? body : JSON.stringify(body);
        if (res.status === 401 || res.status === 403) {
          throw new AuthError(`${res.status} on ${opts.path}: ${detail}`);
        }
        const retryAfterSec = parseRetryAfter(res.headers.get('retry-after'));
        throw new NetworkError(`HTTP ${res.status} on ${opts.path}: ${detail}`, {
          status: res.status,
          ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
        });
      }

      // 2xx
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    }
  }
}

async function readBodySafe(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    if (text.length === 0) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Parse `Retry-After` header per RFC 7231: either a non-negative integer
 * seconds value or an HTTP-date. Returns undefined if absent or unparsable.
 */
function parseRetryAfter(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const asInt = Number(trimmed);
  if (Number.isFinite(asInt) && asInt >= 0) return Math.floor(asInt);
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    const sec = Math.ceil((asDate - Date.now()) / 1000);
    return sec > 0 ? sec : 0;
  }
  return undefined;
}
