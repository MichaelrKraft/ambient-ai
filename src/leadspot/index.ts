/**
 * Public surface of the LeadSpot integration module.
 *
 * Importers should pull from here, not deep paths, so we can reorganize
 * internals without touching the rest of the daemon.
 *
 * Includes: auth, client, mirror sync, self-identity, cost telemetry,
 * extractors, promote pipeline, notifier, and tombstone replication.
 */

export { loginViaLoopback, logout, getAuthStatus } from './auth.js';
export type { AuthStatus } from './auth.js';

export { LeadSpotClient } from './client.js';
export type { GetAccessToken, LeadSpotClientOptions } from './client.js';

export { AccessTokenCache } from './access-token-cache.js';
export type { AccessTokenCacheOptions } from './access-token-cache.js';

export {
  syncContactsOnce,
  ensureMirrorFresh,
  lookupContact,
} from './mirror.js';
export type { ContactCandidate, ContactMatch, SyncResult } from './mirror.js';

export { isSelf, addAlias, removeAlias, listAliases } from './selfid.js';
export type { SelfIdentitySource, SelfIdentityRow } from './selfid.js';

export { recordHaikuUsage, isCappedToday, getTodayUsage } from './cost.js';

export { normalizeEmail, emailHash, normalizeName } from './normalize.js';
export type { NormalizedName } from './normalize.js';

export {
  AuthError,
  AuthExpiredError,
  NetworkError,
  VersionMismatchError,
} from './errors.js';

export type {
  ContactSyncRow,
  ContactSyncResponse,
  CostIncrementRequest,
  CostIncrementResponse,
  DaemonCredentialsLocal,
  PostSignalRequest,
  PostSignalResponse,
  RefreshResponse,
  TokenResponse,
  TombstonePage,
  TombstoneRow,
  TombstoneType,
  VersionResponse,
} from './types.js';

// ---------------------------------------------------------------------------
// Promote pipeline
// ---------------------------------------------------------------------------

export { extractCandidates } from './extractors.js';
export type { ExtractorInput, SignalCandidate } from './extractors.js';

export {
  ingestCandidates,
  tickPromote,
  cancelHeld,
} from './promote.js';
export type {
  PromoteContext,
  IngestResult,
  TickResult,
} from './promote.js';

export { tickTombstones } from './tombstones.js';
export type { TombstoneTickResult } from './tombstones.js';

export { MacNotifier, NoopNotifier } from './notifier.js';
export type { Notifier, NotifierArgs } from './notifier.js';

// ---------------------------------------------------------------------------
// Shared-Mac uid protection
// ---------------------------------------------------------------------------

export { verifySameUser, currentOsUsername } from './uid_check.js';
export type { UidCheckResult } from './uid_check.js';

// ---------------------------------------------------------------------------
// Privacy gate (per-app allowlist)
// ---------------------------------------------------------------------------

export { isExtractionAllowed } from './allowlist.js';
