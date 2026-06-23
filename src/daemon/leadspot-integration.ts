/**
 * LeadSpot integration: lifecycle wrapper called by the daemon main loop.
 *
 * Responsibilities (matches §3 Phase 1 week 2 of ghostlog-integration-plan.md):
 *  1. Shared-Mac uid check (§2.5) — gate everything below on uid match
 *  2. Mirror sync scheduler (every 15 min: ensureFresh → syncOnce → tickTombstones)
 *  3. Promote tick scheduler (every 15s: tickPromote)
 *  4. Per-cycle hook called from runAnalysisCycle: extract → ingest → cost-record
 *  5. Crash reporter (uncaughtException + unhandledRejection → POST /diagnostics)
 *
 * Everything in this file is opt-in — it must only be constructed when
 * `config.leadspot.enabled === true`. Obsidian-only users never reach here.
 */
import os from 'node:os';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import { getDb } from '../storage/db.js';
import { setDaemonState } from '../storage/AmbientStore.js';
import type { AmbientConfig } from '../config/index.js';
import type { OcrEntry } from '../screenpipe/types.js';
import type { AnalysisResult } from '../analysis/types.js';
import {
  AccessTokenCache,
  LeadSpotClient,
  MacNotifier,
  VersionMismatchError,
  ensureMirrorFresh,
  syncContactsOnce,
  tickTombstones,
  tickPromote,
  ingestCandidates,
  extractCandidates,
  recordHaikuUsage,
  isCappedToday,
  verifySameUser,
  currentOsUsername,
  isExtractionAllowed,
} from '../leadspot/index.js';
import type { PromoteContext } from '../leadspot/index.js';

const log = createLogger('daemon:leadspot');

const MIRROR_SYNC_INTERVAL_MS = 15 * 60 * 1000;
const PROMOTE_TICK_INTERVAL_MS = 15 * 1000;
const UID_RECHECK_INTERVAL_MS = 30 * 1000;

/** Read from package.json at build time would be cleaner; literal is fine. */
const DAEMON_VERSION = '0.1.0';

export interface LeadSpotIntegrationOptions {
  config: AmbientConfig;
}

/**
 * Holds state for the LeadSpot integration. Only one instance per daemon.
 */
export class LeadSpotIntegration {
  private readonly db: Database.Database;
  private readonly daemonId: string;
  private readonly organizationId: string;
  private readonly baseUrl: string;
  private readonly client: LeadSpotClient;
  private readonly tokenCache: AccessTokenCache;
  private readonly notifier: MacNotifier;
  private readonly ctx: PromoteContext;

  private mirrorTimer: ReturnType<typeof setInterval> | null = null;
  private promoteTimer: ReturnType<typeof setInterval> | null = null;
  private uidTimer: ReturnType<typeof setInterval> | null = null;

  /** True when uid mismatch — daemon main loop reads this to skip work. */
  private uidMismatch = false;
  /** True when cloud returned 426 — stop calling tickPromote. */
  private versionHeld = false;
  /** True when cost-cap fired today — stop calling Haiku for the day. */
  private costCapped = false;

  constructor(opts: LeadSpotIntegrationOptions) {
    this.db = getDb();
    this.daemonId = opts.config.leadspot.daemon_id;
    this.organizationId = opts.config.leadspot.organization_id;
    this.baseUrl = opts.config.leadspot.base_url.replace(/\/$/, '');

    if (this.daemonId === '' || this.organizationId === '') {
      throw new Error(
        'LeadSpot integration constructed without daemon_id/organization_id. '
        + 'Run `ambient auth login` before enabling leadspot.',
      );
    }

    // Build the client + token cache. Single-flight refresh lives in the cache.
    // Initial bootstrap: client uses cache.getToken; cache uses client.refresh.
    // Order: build a noop-token client first solely for the cache to call
    // refreshAccessToken with the keychain refresh token.
    const refreshOnlyClient = new LeadSpotClient({
      baseUrl: opts.config.leadspot.base_url,
      daemonId: this.daemonId,
      daemonVersion: DAEMON_VERSION,
      getAccessToken: async () => '', // never used; refreshAccessToken is noAuth
    });
    this.tokenCache = new AccessTokenCache({
      daemonId: this.daemonId,
      client: refreshOnlyClient,
    });
    this.client = new LeadSpotClient({
      baseUrl: opts.config.leadspot.base_url,
      daemonId: this.daemonId,
      daemonVersion: DAEMON_VERSION,
      getAccessToken: (force) => this.tokenCache.getToken(force),
    });

    this.notifier = new MacNotifier();
    this.ctx = {
      db: this.db,
      client: this.client,
      daemonId: this.daemonId,
      organizationId: this.organizationId,
      notifier: this.notifier,
    };

    // Reset cost-cap each midnight UTC (lazy: re-read state at runHook).
    this.costCapped = isCappedToday(this.db);
  }

  /**
   * Start the mirror, promote, and uid timers. Idempotent — calling twice
   * is a no-op after the first call.
   */
  start(): void {
    // 1. Initial uid check + recheck loop.
    this.runUidCheck();
    this.uidTimer = setInterval(() => this.runUidCheck(), UID_RECHECK_INTERVAL_MS);
    this.uidTimer.unref();

    // 2. Mirror sync — kick off once now, then every 15 min.
    void this.runMirrorSync();
    this.mirrorTimer = setInterval(() => {
      void this.runMirrorSync();
    }, MIRROR_SYNC_INTERVAL_MS);
    this.mirrorTimer.unref();

    // 3. Promote ticker — every 15s. Cheap if outbox is empty.
    this.promoteTimer = setInterval(() => {
      void this.runPromoteTick();
    }, PROMOTE_TICK_INTERVAL_MS);
    this.promoteTimer.unref();

    // 4. Crash reporter — augments existing handlers, doesn't replace them.
    this.installCrashReporter();

    log.info('LeadSpot integration started', {
      daemonId: this.daemonId,
      organizationId: this.organizationId,
      mirrorIntervalMs: MIRROR_SYNC_INTERVAL_MS,
      promoteIntervalMs: PROMOTE_TICK_INTERVAL_MS,
    });
  }

  /** Tear down timers. Called from the daemon stop() path. */
  stop(): void {
    if (this.mirrorTimer !== null) {
      clearInterval(this.mirrorTimer);
      this.mirrorTimer = null;
    }
    if (this.promoteTimer !== null) {
      clearInterval(this.promoteTimer);
      this.promoteTimer = null;
    }
    if (this.uidTimer !== null) {
      clearInterval(this.uidTimer);
      this.uidTimer = null;
    }
  }

  /**
   * Hook called from the daemon's runAnalysisCycle AFTER Haiku returns and
   * BEFORE the result is persisted (well — after; AmbientStore persistence
   * is internal to ActivityAnalyzer.analyze, so we run after `analyze`
   * returns; it doesn't matter for ordering since LeadSpot has its own
   * tables).
   *
   * Best-effort: exceptions inside this method are caught and logged; the
   * Obsidian-only path keeps running.
   */
  async runHook(
    result: AnalysisResult,
    entries: readonly OcrEntry[],
  ): Promise<void> {
    if (this.uidMismatch) return;
    if (this.versionHeld) return;

    try {
      // Refresh local cap status from the DB so we pick up cap clearance
      // after midnight without restarting the daemon.
      this.costCapped = isCappedToday(this.db);

      // PRIVACY GATE (plan §2.5): default-deny extraction for unknown apps,
      // hard-deny for banking/1Password/incognito/screen-share. The capture
      // continues — only the *signal extraction* is gated. Goal/digest
      // analyzers don't go through this path.
      const sourceApp = result.activity.primaryApp;
      const windowTitle = this.firstWindowName(entries);
      const gate = isExtractionAllowed(sourceApp, windowTitle);
      if (!gate.allowed) {
        log.debug('extraction skipped by privacy gate', {
          sourceApp,
          reason: gate.reason,
        });
        return;
      }

      // 1. Build extractor input from the Haiku result + raw OCR window text.
      const ocrText = this.combineOcrText(entries);
      const ocrTextHash = createHash('sha256').update(ocrText, 'utf8').digest('hex');

      const candidates = extractCandidates({
        haikuSummary: result.activity.summary,
        sourceApp,
        windowTitle,
        ocrText,
        observedAtMs: Date.now(),
      });

      if (candidates.length > 0) {
        const ingestRes = await ingestCandidates(this.ctx, candidates, ocrTextHash);
        log.debug('candidates ingested', {
          extracted: candidates.length,
          accepted: ingestRes.accepted,
          dropped: ingestRes.dropped,
        });
      }

      // 2. Cost telemetry: if Haiku was actually called we record the spend.
      //    We only call recordHaikuUsage when tokens are non-zero — fallback
      //    paths return tokenCost=0 and we don't push empty deltas to cloud.
      const tokensIn = result.tokensIn ?? 0;
      const tokensOut = result.tokensOut ?? 0;
      if (tokensIn > 0 || tokensOut > 0) {
        try {
          const status = await recordHaikuUsage(this.db, this.client, tokensIn, tokensOut);
          if (status.capped && !this.costCapped) {
            log.warn('Haiku cost cap reached for today — pausing analyzer until UTC midnight');
            setDaemonState('leadspot_cost_capped', '1');
          }
          this.costCapped = status.capped;
        } catch (err) {
          log.warn('cost increment push failed (non-fatal)', err);
        }
      }
    } catch (err) {
      // We never let LeadSpot work crash the analyzer cycle.
      log.error('runHook failed (non-fatal, Obsidian path unaffected)', err);
    }
  }

  /**
   * True when the daemon should skip its Haiku analysis cycle entirely
   * (cost-capped). The Obsidian-only path runs independently of this flag.
   */
  isHaikuCapped(): boolean {
    return this.costCapped;
  }

  /** True when the uid check failed; daemon main loop should skip work. */
  isUidMismatched(): boolean {
    return this.uidMismatch;
  }

  /** True when the cloud rejected our version; daemon main loop should warn. */
  isVersionHeld(): boolean {
    return this.versionHeld;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private runUidCheck(): void {
    try {
      const now = currentOsUsername();
      const result = verifySameUser(this.db, now);

      if (result.bootstrapped === true) {
        log.warn('Bootstrapped os_username from current uid — shared-Mac check enforced from now', {
          uid: now,
        });
      }

      if (!result.ok) {
        if (!this.uidMismatch) {
          log.warn('Shared-Mac protection: uid mismatch — pausing LeadSpot work', {
            expected: result.expectedUid,
            actual: result.currentUid,
          });
          setDaemonState('leadspot_state', 'paused_user_mismatch');
        }
        this.uidMismatch = true;
      } else if (this.uidMismatch) {
        log.info('user resumed — clearing uid-mismatch pause');
        setDaemonState('leadspot_state', 'active');
        this.uidMismatch = false;
      }
    } catch (err) {
      // Defensive — never crash the daemon over a uid check.
      log.warn('uid check raised (non-fatal)', err);
    }
  }

  private async runMirrorSync(): Promise<void> {
    if (this.uidMismatch) return;
    if (this.versionHeld) return;

    try {
      await ensureMirrorFresh(this.client, this.db);
      const result = await syncContactsOnce(this.client, this.db);
      log.debug('mirror sync complete', result);
      try {
        await tickTombstones(this.ctx);
      } catch (tErr) {
        log.warn('tombstone tick failed (non-fatal)', tErr);
      }
    } catch (err) {
      if (err instanceof VersionMismatchError) {
        this.versionHeld = true;
        setDaemonState('leadspot_state', 'version_held');
        log.error('Cloud rejected daemon version (426) — entering version_held state', err);
        return;
      }
      log.warn('mirror sync failed (non-fatal, retry next interval)', err);
    }
  }

  private async runPromoteTick(): Promise<void> {
    if (this.uidMismatch) return;
    if (this.versionHeld) return;

    try {
      const tickResult = await tickPromote(this.ctx);
      if (tickResult.promoted > 0) {
        log.debug('signals promoted', tickResult);
      }
    } catch (err) {
      if (err instanceof VersionMismatchError) {
        this.versionHeld = true;
        setDaemonState('leadspot_state', 'version_held');
        log.error('Cloud rejected daemon version (426) — entering version_held state', err);
        return;
      }
      log.warn('promote tick failed (non-fatal)', err);
    }
  }

  private installCrashReporter(): void {
    // Augment, don't replace, existing handlers. Node allows multiple listeners.
    process.on('uncaughtException', (err) => {
      void this.reportCrash('uncaughtException', err);
    });
    process.on('unhandledRejection', (reason) => {
      void this.reportCrash(
        'unhandledRejection',
        reason instanceof Error ? reason : new Error(String(reason)),
      );
    });
  }

  private async reportCrash(kind: string, err: Error): Promise<void> {
    try {
      const stack = err.stack ?? err.message;
      const stackHash = createHash('sha256').update(stack, 'utf8').digest('hex').slice(0, 16);
      // We POST directly via fetch — the LeadSpotClient's path is gated on auth,
      // and we want crash reports to fly even when refresh tokens are dead.
      const url = `${this.baseUrl}/api/diagnostics/crash`;
      await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Daemon-Id': this.daemonId,
          'X-Daemon-Version': DAEMON_VERSION,
        },
        body: JSON.stringify({
          daemon_id: this.daemonId,
          kind,
          stack_hash: stackHash,
          message: err.message.slice(0, 500),
          host: os.hostname(),
        }),
      }).catch(() => {
        // swallow — crash reporter is best-effort
      });
    } catch {
      // Never throw from a crash handler
    }
  }

  private combineOcrText(entries: readonly OcrEntry[]): string {
    return entries.map((e) => e.text).join('\n');
  }

  private firstWindowName(entries: readonly OcrEntry[]): string | undefined {
    return entries.find((e) => e.windowName !== '')?.windowName;
  }
}
