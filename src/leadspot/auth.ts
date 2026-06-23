/**
 * Loopback-OAuth login flow + auth status helpers.
 *
 * Flow (matches §2.4 of the integration plan):
 *  1. daemon binds an HTTP server to localhost:0 (kernel picks free port)
 *  2. opens browser to {baseUrl}/api/daemon/auth?cb=...&state=...&device_label=...
 *  3. user clicks "Authorize this Mac" in their already-logged-in session
 *  4. cloud 302s to http://localhost:<port>/cb?code=...&state=...
 *  5. daemon validates state, POSTs code to /api/daemon/auth/token
 *  6. daemon stores refresh_token in Keychain + writes daemon_credentials_local
 *  7. self_identity gets user_email + user_email_aliases (source='oauth')
 *
 * No external HTTP framework — pure node:http to keep the surface tiny.
 */
import http from 'node:http';
import os from 'node:os';
import { exec } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { URL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createLogger } from '../shared/logger.js';
import { getDb } from '../storage/db.js';
import { AuthError } from './errors.js';
import { saveRefreshToken, deleteRefreshToken } from './keychain.js';
import type { DaemonCredentialsLocal, TokenResponse } from './types.js';
import { addAlias } from './selfid.js';

const log = createLogger('leadspot:auth');

/** 5 minutes — long enough for the user to find the browser tab. */
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

interface CallbackResult {
  code: string;
  state: string;
}

/**
 * Run the loopback-OAuth flow and persist credentials.
 *
 * @param baseUrl     LeadSpot cloud base URL (no trailing slash)
 * @param deviceLabel Human-readable label, e.g. os.hostname()
 *
 * @throws AuthError on timeout, state mismatch, code rejection, or HTTP
 *         failure exchanging code → tokens.
 */
export async function loginViaLoopback(
  baseUrl: string,
  deviceLabel: string,
): Promise<DaemonCredentialsLocal> {
  const state = randomBytes(16).toString('hex');
  const { code, port } = await runCallbackServer(state, baseUrl, deviceLabel);

  const tokenRes = await exchangeCodeForTokens(baseUrl, code, state);

  // Persist non-secret credentials to SQLite.
  // Capture os_username so the shared-Mac uid check (§2.5) has a baseline.
  const osUsername = readOsUsername();
  const creds: DaemonCredentialsLocal = {
    daemon_id: tokenRes.daemon_id,
    organization_id: tokenRes.organization_id,
    user_email: tokenRes.user_email,
    device_label: deviceLabel,
    created_at: Date.now(),
    os_username: osUsername,
  };
  persistCredentials(creds);

  // Persist secret to Keychain.
  await saveRefreshToken(tokenRes.daemon_id, tokenRes.refresh_token);

  // Populate self_identity so we drop signals about the user themselves.
  await addAlias(getDb(), tokenRes.user_email, 'oauth');
  for (const alias of tokenRes.user_email_aliases) {
    await addAlias(getDb(), alias, 'oauth');
  }

  log.info('Loopback OAuth login succeeded', {
    daemonId: tokenRes.daemon_id,
    deviceLabel,
    port,
  });
  return creds;
}

/**
 * Reverse of loginViaLoopback: drop Keychain entry + local credentials row.
 *
 * NOTE: We don't call DELETE /api/daemon/auth/devices/{daemon_id} because
 * that endpoint requires a user JWT, which the daemon doesn't have. Users
 * can revoke from the LeadSpot dashboard if they want server-side revocation.
 */
export async function logout(daemonId: string): Promise<void> {
  if (!daemonId) {
    log.warn('logout called with empty daemonId — nothing to do');
    return;
  }
  await deleteRefreshToken(daemonId);
  getDb()
    .prepare('DELETE FROM daemon_credentials_local WHERE daemon_id = ?')
    .run(daemonId);
  log.info('Local credentials cleared', { daemonId });
}

export interface AuthStatus {
  authenticated: boolean;
  deviceLabel?: string;
  organizationId?: string;
  userEmail?: string;
  /** Set by AccessTokenCache after a failed refresh; we don't read it from
   *  cloud. Reserved for future enhancement. */
  lastRefreshError?: string;
}

/**
 * Quick check: do we have a daemon_credentials_local row for this daemonId?
 *
 * Note: this does NOT verify that the Keychain entry is still valid. That
 * costs a network round-trip via AccessTokenCache; do it explicitly when
 * you need to know.
 */
export async function getAuthStatus(daemonId: string): Promise<AuthStatus> {
  if (!daemonId) return { authenticated: false };
  const row = getDb()
    .prepare(
      'SELECT device_label, organization_id, user_email '
        + 'FROM daemon_credentials_local WHERE daemon_id = ?',
    )
    .get(daemonId) as
    | { device_label: string; organization_id: string; user_email: string }
    | undefined;
  if (row === undefined) return { authenticated: false };
  return {
    authenticated: true,
    deviceLabel: row.device_label,
    organizationId: row.organization_id,
    userEmail: row.user_email,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function runCallbackServer(
  expectedState: string,
  baseUrl: string,
  deviceLabel: string,
): Promise<{ code: string; port: number }> {
  return await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        if (req.url === undefined || !req.url.startsWith('/cb')) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        const parsed = new URL(req.url, 'http://localhost');
        const code = parsed.searchParams.get('code');
        const gotState = parsed.searchParams.get('state');
        if (gotState !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<h1>State mismatch</h1><p>You can close this window.</p>');
          server.close();
          reject(new AuthError('OAuth state mismatch — possible CSRF'));
          return;
        }
        if (code === null || code.length === 0) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<h1>Missing code</h1>');
          server.close();
          reject(new AuthError('OAuth callback missing code'));
          return;
        }
        const result: CallbackResult = { code, state: gotState };
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<!doctype html><html><head><meta charset="utf-8"></head>'
            + '<body style="font-family:system-ui;text-align:center;padding:64px">'
            + '<h1>Authorized</h1><p>You can close this window.</p>'
            + '</body></html>',
        );
        server.close();
        resolve({ code: result.code, port: (server.address() as AddressInfo).port });
      } catch (err) {
        server.close();
        reject(err);
      }
    });

    const timeout = setTimeout(() => {
      server.close();
      reject(new AuthError('Browser approval timed out (5 min)'));
    }, CALLBACK_TIMEOUT_MS);

    server.on('close', () => clearTimeout(timeout));
    server.on('error', (err) => {
      clearTimeout(timeout);
      reject(new AuthError(`Local callback server error: ${err.message}`));
    });

    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      const url
        = `${baseUrl.replace(/\/$/, '')}/api/daemon/auth`
        + `?cb=${encodeURIComponent(`http://localhost:${port}/cb`)}`
        + `&state=${expectedState}`
        + `&device_label=${encodeURIComponent(deviceLabel)}`;
      log.info(`Opening browser for OAuth: ${url}`);
      // macOS-only for v1 per plan §8 (Windows 2026, Linux out of scope).
      exec(`open "${url}"`, (err) => {
        if (err) {
          log.warn(`Failed to open browser automatically: ${err.message}`);
          process.stdout.write(
            `\n>>> Open this URL in your browser to authorize:\n${url}\n\n`,
          );
        }
      });
    });
  });
}

async function exchangeCodeForTokens(
  baseUrl: string,
  code: string,
  state: string,
): Promise<TokenResponse> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/daemon/auth/token`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, state }),
    });
  } catch (err) {
    throw new AuthError(
      `Failed to reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new AuthError(
      `Token exchange rejected (HTTP ${res.status}): ${detail || 'no body'} — try again`,
    );
  }
  return (await res.json()) as TokenResponse;
}

function persistCredentials(creds: DaemonCredentialsLocal): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO daemon_credentials_local
       (daemon_id, organization_id, user_email, device_label, created_at, os_username)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      creds.daemon_id,
      creds.organization_id,
      creds.user_email,
      creds.device_label,
      creds.created_at,
      creds.os_username ?? null,
    );
}

/**
 * Best-effort current OS username. `os.userInfo()` can throw if /etc/passwd
 * has no entry; fall back to env vars in that case. We never want this to
 * crash auth login — empty string means "unknown, don't enforce uid check."
 */
function readOsUsername(): string {
  try {
    const info = os.userInfo();
    if (info.username !== '') return info.username;
  } catch {
    // fall through to env
  }
  return process.env.USER ?? process.env.LOGNAME ?? '';
}
