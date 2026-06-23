/**
 * AccessTokenCache tests (§12.5 of ghostlog-integration-plan.md).
 *
 * Tests:
 *  1. Single-flight: 5 concurrent getToken() calls → exactly 1 network call
 *  2. Empty refresh_token grace: server returns "" → Keychain NOT overwritten
 *  3. 401 from refresh → throws AuthExpiredError
 *  4. Cache hit: second call within TTL → no network call
 *  5. forceRefresh=true → skips cache and refreshes
 *  6. No Keychain entry → throws AuthExpiredError immediately
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AccessTokenCache } from '../../src/leadspot/access-token-cache.js';
import { AuthExpiredError } from '../../src/leadspot/errors.js';

// ---------------------------------------------------------------------------
// Mock keychain module (the real one requires macOS Keychain API).
// ---------------------------------------------------------------------------

// We mock the keychain module before importing AccessTokenCache to avoid
// the native binding. Vitest's vi.mock is hoisted, so this declaration is
// evaluated before module resolution.
vi.mock('../../src/leadspot/keychain.js', () => {
  return {
    loadRefreshToken: vi.fn(),
    saveRefreshToken: vi.fn(),
    deleteRefreshToken: vi.fn(),
  };
});

// Import mocked keychain functions after vi.mock.
import * as keychain from '../../src/leadspot/keychain.js';

// ---------------------------------------------------------------------------
// Mock LeadSpotClient (only refreshAccessToken is used by AccessTokenCache).
// ---------------------------------------------------------------------------

function makeClient(overrides: {
  refreshResult?: { refresh_token: string; access_token: string; expires_in: number };
  refreshError?: Error;
  callDelay?: number;
} = {}) {
  let callCount = 0;
  return {
    refreshAccessToken: vi.fn(async (_refreshToken: string) => {
      callCount += 1;
      if (overrides.callDelay !== undefined) {
        await new Promise((r) => setTimeout(r, overrides.callDelay));
      }
      if (overrides.refreshError !== undefined) throw overrides.refreshError;
      return overrides.refreshResult ?? {
        refresh_token: 'new-refresh-token',
        access_token: 'new-access-token-' + callCount,
        expires_in: 900,
      };
    }),
    _getCallCount: () => callCount,
  } as unknown as import('../../src/leadspot/client.js').LeadSpotClient & { _getCallCount: () => number };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const DAEMON_ID = 'test-daemon-001';
const EXISTING_REFRESH_TOKEN = 'stored-refresh-token-abc';

function makeCache(client: import('../../src/leadspot/client.js').LeadSpotClient) {
  return new AccessTokenCache({ daemonId: DAEMON_ID, client });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(keychain.loadRefreshToken).mockResolvedValue(EXISTING_REFRESH_TOKEN);
  vi.mocked(keychain.saveRefreshToken).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. Single-flight: concurrent getToken() calls share one refresh
// ---------------------------------------------------------------------------

describe('AccessTokenCache single-flight refresh', () => {
  it('5 concurrent getToken() calls trigger exactly 1 network request', async () => {
    const client = makeClient({ callDelay: 50 });
    const cache = makeCache(client);

    // Fire 5 concurrent getToken() calls.
    const results = await Promise.all([
      cache.getToken(),
      cache.getToken(),
      cache.getToken(),
      cache.getToken(),
      cache.getToken(),
    ]);

    // All callers got a token.
    expect(results).toHaveLength(5);
    for (const token of results) {
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
    }

    // Only one network call was made (single-flight guarantee).
    expect(vi.mocked(client.refreshAccessToken)).toHaveBeenCalledTimes(1);
  });

  it('all concurrent callers receive the same access token', async () => {
    const client = makeClient({ callDelay: 30 });
    const cache = makeCache(client);

    const tokens = await Promise.all(
      Array.from({ length: 5 }, () => cache.getToken()),
    );

    const unique = new Set(tokens);
    expect(unique.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Empty refresh_token grace: server returns "" → Keychain NOT overwritten
// ---------------------------------------------------------------------------

describe('AccessTokenCache empty refresh_token grace', () => {
  it('does not call saveRefreshToken when server returns empty refresh_token', async () => {
    const client = makeClient({
      refreshResult: {
        refresh_token: '',  // Server signaling "keep your existing token".
        access_token: 'fresh-access-token',
        expires_in: 900,
      },
    });
    const cache = makeCache(client);

    const token = await cache.getToken();
    expect(token).toBe('fresh-access-token');

    // Keychain must NOT be overwritten when refresh_token is "".
    expect(vi.mocked(keychain.saveRefreshToken)).not.toHaveBeenCalled();
  });

  it('does not call saveRefreshToken when server returns same refresh_token', async () => {
    const client = makeClient({
      refreshResult: {
        refresh_token: EXISTING_REFRESH_TOKEN, // Same token returned.
        access_token: 'fresh-access-token',
        expires_in: 900,
      },
    });
    const cache = makeCache(client);

    await cache.getToken();

    // Same token → no need to re-persist.
    expect(vi.mocked(keychain.saveRefreshToken)).not.toHaveBeenCalled();
  });

  it('calls saveRefreshToken when server returns a new non-empty refresh_token', async () => {
    const client = makeClient({
      refreshResult: {
        refresh_token: 'brand-new-refresh-token',
        access_token: 'fresh-access-token',
        expires_in: 900,
      },
    });
    const cache = makeCache(client);

    await cache.getToken();

    expect(vi.mocked(keychain.saveRefreshToken)).toHaveBeenCalledWith(
      DAEMON_ID,
      'brand-new-refresh-token',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. 401 from refresh → throws AuthExpiredError
// ---------------------------------------------------------------------------

describe('AccessTokenCache auth errors', () => {
  it('throws AuthExpiredError when refresh call returns 401', async () => {
    const { AuthError } = await import('../../src/leadspot/errors.js');
    const authErr = new AuthError('401 on /api/daemon/auth/refresh: Unauthorized');

    const client = makeClient({ refreshError: authErr });
    const cache = makeCache(client);

    await expect(cache.getToken()).rejects.toThrow(AuthExpiredError);
  });

  it('throws AuthExpiredError when Keychain has no refresh token', async () => {
    vi.mocked(keychain.loadRefreshToken).mockResolvedValue(null);

    const client = makeClient();
    const cache = makeCache(client);

    await expect(cache.getToken()).rejects.toThrow(AuthExpiredError);
    // No network call should be made.
    expect(vi.mocked(client.refreshAccessToken)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Cache hit: second call within TTL → no extra network call
// ---------------------------------------------------------------------------

describe('AccessTokenCache cache hit', () => {
  it('second getToken() within TTL returns cached token without network call', async () => {
    const client = makeClient();
    const cache = makeCache(client);

    const token1 = await cache.getToken();
    const token2 = await cache.getToken();

    expect(token1).toBe(token2);
    expect(vi.mocked(client.refreshAccessToken)).toHaveBeenCalledTimes(1);
  });

  it('cache expires after TTL and triggers a refresh', async () => {
    vi.useFakeTimers();

    const client = makeClient({
      refreshResult: {
        refresh_token: 'rotating-refresh',
        access_token: 'access-token-v1',
        expires_in: 30, // 30s TTL; buffer is 60s so effective TTL = max(0, 30000-60000) = 0
      },
    });
    vi.mocked(keychain.saveRefreshToken).mockResolvedValue(undefined);

    const cache = makeCache(client);
    await cache.getToken();

    // Advance past the token's TTL (expires_in=30s but with buffer it's effectively expired immediately).
    vi.advanceTimersByTime(31_000);

    await cache.getToken();

    // Should have refreshed a second time.
    expect(vi.mocked(client.refreshAccessToken)).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 5. forceRefresh bypasses the cache
// ---------------------------------------------------------------------------

describe('AccessTokenCache forceRefresh', () => {
  it('forceRefresh=true always makes a network call even if cache is warm', async () => {
    const client = makeClient();
    const cache = makeCache(client);

    await cache.getToken();           // Warms the cache.
    await cache.getToken(true);       // Force refresh.

    expect(vi.mocked(client.refreshAccessToken)).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 6. invalidate() forces next getToken() to refresh
// ---------------------------------------------------------------------------

describe('AccessTokenCache invalidate', () => {
  it('invalidate() causes the next getToken() to refresh', async () => {
    const client = makeClient();
    const cache = makeCache(client);

    await cache.getToken();           // Warms the cache.
    cache.invalidate();
    await cache.getToken();           // Should refresh again.

    expect(vi.mocked(client.refreshAccessToken)).toHaveBeenCalledTimes(2);
  });
});
