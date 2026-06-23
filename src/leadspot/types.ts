/**
 * Wire types shared between client / mirror / auth / cost.
 * These mirror the FastAPI response schemas; keep them in sync if the
 * backend contract changes.
 */

export interface VersionResponse {
  server_version: string;
  min_daemon_version: string;
  current_daemon_version: string;
}

export interface TokenResponse {
  daemon_id: string;
  organization_id: string;
  user_email: string;
  user_email_aliases: string[];
  refresh_token: string;
  access_token: string;
  /** Seconds until access_token expires. */
  expires_in: number;
}

export interface RefreshResponse {
  /** Empty string means "keep using the current refresh token" (60s grace). */
  refresh_token: string;
  access_token: string;
  expires_in: number;
}

export interface ContactSyncRow {
  contact_id: string;
  email_hash: string | null;
  aliases: string[];
  linkedin_slug: string | null;
  name_norm: string | null;
  company_norm: string | null;
  /** ISO8601 string. */
  updated_at: string;
  deleted: boolean;
}

export interface ContactSyncResponse {
  contacts: ContactSyncRow[];
  /** Cursor to pass as `since` on the next request. Null means done. */
  next_since: string | null;
}

export interface CostIncrementRequest {
  haiku_tokens_in?: number;
  haiku_tokens_out?: number;
  sonnet_tokens_in?: number;
  sonnet_tokens_out?: number;
  signal_count?: number;
}

export interface CostIncrementResponse {
  cost_capped: boolean;
}

export interface DaemonCredentialsLocal {
  daemon_id: string;
  organization_id: string;
  user_email: string;
  device_label: string;
  created_at: number;
  /** macOS login name captured at OAuth-login time (§2.5 shared-Mac protection).
   *  Optional for back-compat with pre-v5 schema rows. */
  os_username?: string | null;
}

// ---------------------------------------------------------------------------
// Promote pipeline wire types
// ---------------------------------------------------------------------------

export interface PostSignalRequest {
  idempotency_key: string;
  contact_match_key: string;
  source: string;
  source_app: string | null;
  extractor: string;
  summary: string;
  confidence: number;
  observed_at: string;
  ocr_snippet_hash: string | null;
  extras: Record<string, unknown> | null;
  daemon_id: string;
  schema_version: number;
}

export interface PostSignalResponse {
  signal_id: string;
  contact_id: string | null;
  state: string;
}

export type TombstoneType = 'signal' | 'contact' | 'email_hash' | 'subscription';

export interface TombstoneRow {
  id: string;
  tombstone_type: TombstoneType;
  signal_id: string | null;
  contact_id: string | null;
  email_hash: string | null;
  issued_at: string;
}

export interface TombstonePage {
  tombstones: TombstoneRow[];
  next_since: string | null;
}
