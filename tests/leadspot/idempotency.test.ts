/**
 * Idempotency tests (§12.3 of ghostlog-integration-plan.md).
 *
 * Core property: ingesting the same candidate 100× should produce exactly
 * one leadspot_signals row and at most one leadspot_outbox entry.
 *
 * The idempotency key is sha256(minute | matchKey | extractor | ocrHash).
 * Same inputs within the same minute → same key → INSERT is skipped.
 *
 * We also verify the integrity constraint is hit on a deliberate second insert
 * so we know the DB layer is enforcing the guarantee, not just our code.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { countRows, insertContact, openTestDb, stampMirrorFresh } from './helpers/db.js';
import { ingestCandidates } from '../../src/leadspot/promote.js';
import type { PromoteContext } from '../../src/leadspot/promote.js';
import { NoopNotifier } from '../../src/leadspot/notifier.js';
import { emailHash } from '../../src/leadspot/normalize.js';
import type { SignalCandidate } from '../../src/leadspot/extractors.js';

// Stub LeadSpotClient — we don't actually post to cloud for idempotency tests.
function makeStubClient() {
  return {
    postSignal: vi.fn().mockResolvedValue({
      signal_id: randomUUID(),
      contact_id: null,
      state: 'promoted',
    }),
    getTombstones: vi.fn().mockResolvedValue({ tombstones: [], next_since: null }),
    syncContacts: vi.fn().mockResolvedValue({ contacts: [], next_since: null }),
    getVersion: vi.fn().mockResolvedValue({ server_version: '1.0.0', min_daemon_version: '1.0.0', current_daemon_version: '1.0.0' }),
    refreshAccessToken: vi.fn(),
    incrementCost: vi.fn().mockResolvedValue({ cost_capped: false }),
  } as unknown as import('../../src/leadspot/client.js').LeadSpotClient;
}

function makeContext(db: Database.Database): PromoteContext {
  return {
    db,
    client: makeStubClient(),
    daemonId: 'test-daemon-001',
    organizationId: 'test-org-001',
    notifier: new NoopNotifier(),
  };
}

// A deterministic candidate fixture.
function makeCandidate(emailAddr: string): SignalCandidate {
  const hash = emailHash(emailAddr);
  return {
    extractor: 'explicit_email',
    matchKey: hash,
    matchKeyType: 'email_hash',
    baseConfidence: 90,
    redactedSummary: `Email mention · ${emailAddr.split('@')[1] ?? 'example.com'}`,
    ocrSnippetHash: undefined,
  };
}

describe('ingestCandidates idempotency', () => {
  let db: Database.Database;
  let ctx: PromoteContext;

  beforeEach(() => {
    db = openTestDb();
    ctx = makeContext(db);
    stampMirrorFresh(db);
    // We use a contact so the signal doesn't immediately drop as unmatched.
    // Insert a contact so the confidence lands in a real range.
    insertContact(db, {
      contactId: 'contact-jane-001',
      emailHash: emailHash('jane@acme.com'),
      aliases: [emailHash('jane@acme.com'), emailHash('jane+sales@acme.com')],
      nameNorm: 'jane smith',
    });
  });

  it('ingesting same candidate 100x results in exactly 1 signal row', async () => {
    const candidate = makeCandidate('jane@acme.com');
    const ocrHash = 'fixed-ocr-hash-for-idempotency';

    // Use a fixed timestamp so all 100 ingests share the same minute bucket.
    const now = Date.now();
    vi.setSystemTime(now);

    for (let i = 0; i < 100; i += 1) {
      await ingestCandidates(ctx, [candidate], ocrHash);
    }

    vi.useRealTimers();

    expect(countRows(db, 'leadspot_signals')).toBe(1);
  });

  it('ingesting same candidate twice produces exactly 1 outbox row (not 2)', async () => {
    const candidate = makeCandidate('jane@acme.com');
    const ocrHash = 'fixed-ocr-hash-dedup';

    const now = Date.now();
    vi.setSystemTime(now);

    await ingestCandidates(ctx, [candidate], ocrHash);
    await ingestCandidates(ctx, [candidate], ocrHash);

    vi.useRealTimers();

    // At most 1 outbox row (if signal is held_local it won't be in outbox yet)
    expect(countRows(db, 'leadspot_outbox')).toBeLessThanOrEqual(1);
    expect(countRows(db, 'leadspot_signals')).toBe(1);
  });

  it('different candidates in same call produce distinct signal rows', async () => {
    // Insert a second contact.
    insertContact(db, {
      contactId: 'contact-bob-001',
      emailHash: emailHash('bob@example.com'),
      aliases: [emailHash('bob@example.com')],
    });

    const candidates: SignalCandidate[] = [
      makeCandidate('jane@acme.com'),
      makeCandidate('bob@example.com'),
    ];

    await ingestCandidates(ctx, candidates, 'ocr-hash-two-candidates');
    expect(countRows(db, 'leadspot_signals')).toBe(2);
  });

  it('UNIQUE constraint on idempotency_key is enforced at DB level', () => {
    // Verify the schema constraint exists and would reject a duplicate insert.
    const idemKey = 'fixed-test-idem-key';
    const id1 = randomUUID();
    const id2 = randomUUID();

    db
      .prepare(
        `INSERT INTO leadspot_signals
          (id, idempotency_key, contact_id, contact_match_key, source, source_app,
           extractor, summary, confidence, state, observed_at, created_at)
         VALUES (?, ?, null, 'key', 'ambient_screen', null, 'explicit_email', 'test', 90, 'held_local', ?, ?)`,
      )
      .run(id1, idemKey, Date.now(), Date.now());

    expect(() => {
      db
        .prepare(
          `INSERT INTO leadspot_signals
            (id, idempotency_key, contact_id, contact_match_key, source, source_app,
             extractor, summary, confidence, state, observed_at, created_at)
           VALUES (?, ?, null, 'key', 'ambient_screen', null, 'explicit_email', 'test', 90, 'held_local', ?, ?)`,
        )
        .run(id2, idemKey, Date.now(), Date.now());
    }).toThrow();
  });

  it('different ocrHash for same matchKey+extractor within same minute → new signal', async () => {
    const candidate = makeCandidate('jane@acme.com');

    const now = Date.now();
    vi.setSystemTime(now);

    await ingestCandidates(ctx, [candidate], 'ocr-hash-A');
    await ingestCandidates(ctx, [candidate], 'ocr-hash-B');

    vi.useRealTimers();

    // Different ocrHash → different idempotency_key → 2 rows
    expect(countRows(db, 'leadspot_signals')).toBe(2);
  });
});
