/**
 * macOS Keychain wrapper for the daemon's refresh token.
 *
 * Service: "ai.leadspot.ambient"
 * Account: the opaque daemon_id (UUID) issued by the cloud at OAuth time.
 *
 * The refresh token is the only secret stored on disk. Access tokens are
 * 15-minute JWTs and live in process memory (AccessTokenCache). The
 * daemon_id + organization_id are NON-secret; those go in
 * daemon_credentials_local in SQLite.
 *
 * Why keytar:
 *  - On macOS it talks to the real Keychain via the Security framework.
 *  - On Linux it falls back to libsecret; on Windows to Credential Manager.
 *  - We're macOS-only in v1, but the abstraction means CI on Linux still works.
 */
import keytar from 'keytar';

const SERVICE_NAME = 'ai.leadspot.ambient';

/**
 * Store the refresh token. Overwrites any existing entry for daemonId.
 * keytar.setPassword is idempotent — no need to delete first.
 */
export async function saveRefreshToken(
  daemonId: string,
  token: string,
): Promise<void> {
  if (!daemonId) {
    throw new Error('saveRefreshToken: daemonId is required');
  }
  if (!token) {
    throw new Error('saveRefreshToken: empty token');
  }
  await keytar.setPassword(SERVICE_NAME, daemonId, token);
}

/**
 * Retrieve the refresh token. Returns null if no entry exists, e.g. the
 * user logged out, the Keychain entry was manually deleted, or this daemon
 * has never authenticated.
 */
export async function loadRefreshToken(
  daemonId: string,
): Promise<string | null> {
  if (!daemonId) return null;
  return await keytar.getPassword(SERVICE_NAME, daemonId);
}

/**
 * Delete the refresh token. Returns true if a record was deleted, false if
 * no record existed. Both outcomes are valid — callers shouldn't error on
 * "already absent."
 */
export async function deleteRefreshToken(daemonId: string): Promise<boolean> {
  if (!daemonId) return false;
  return await keytar.deletePassword(SERVICE_NAME, daemonId);
}
