/**
 * Tombstone tests (§12.4 of ghostlog-integration-plan.md).
 *
 * Tests:
 *  1. signal tombstone → signal row becomes 'redacted'
 *  2. contact tombstone → all signals for that contact redacted + mirror entry removed
 *  3. email_hash tombstone → signals matching that match_key redacted
 *  4. subscription tombstone → all leadspot_* tables wiped
 *  5. Idempotency: same tombstone applied twice → only one effect
 *  6. Already-seen tombstones are skipped (dedup)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  countRows,
  getSignal,
  insertContact,
  openTestDb,
  stampMirrorFresh,
} from './helpers/db.js';
import { tickTombstones } from '../../src/leadspot/tombstones.js';
import type { PromoteContext } from '../../src/leadspot/promote.js';
import { NoopNotifier } from '../../src/leadspot/notifier.js';
import { emailHash } from '../../src/leadspot/normalize.js';
import type { TombstoneRow } from '../../src/leadspot/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTombstoneClient(pages: Array<{ tombstones: TombstoneRow[]; next_since: string | null }>) {
  let callIndex = 0;
  return {
    getTombstones: vi.fn(async () => {
      const page = pages[callIndex] ?? { tombstones: [], next_since: null };
      callIndex += 1;
      return page;
    }),
    postSignal: vi.fn(),
    syncContacts: vi.fn(),
    getVersion: vi.fn(),
    refreshAccessToken: vi.fn(),
    incrementCost: vi.fn().mockResolvedValue({ cost_capped: false }),
  } as unknown as import('../../src/leadspot/client.js').LeadSpotClient;
}

function makeContext(
  db: Database.Database,
  tombstones: TombstoneRow[],
): PromoteContext {
  return {
    db,
    client: makeTombstoneClient([{ tombstones, next_since: null }]),
    daemonId: 'test-daemon-001',
    organizationId: 'test-org-001',
    notifier: new NoopNotifier(),
  };
}

/** Insert a signal row in a specific state. Returns the signal id. */
function insertSignal(
  db: Database.Database,
  opts: {
    contactId?: string;
    contactMatchKey: string;
    state?: string;
  },
): string {
  const id = randomUUID();
  const now = Date.now();
  db
    .prepare(
      `INSERT INTO leadspot_signals
        (id, idempotency_key, contact_id, contact_match_key, source, source_app,
         extractor, summary, confidence, state, observed_at, created_at)
       VALUES (?, ?, ?, ?, 'ambient_screen', null, 'explicit_email', 'test summary', 90, ?, ?, ?)`,
    )
    .run(id, randomUUID(), opts.contactId ?? null, opts.contactMatchKey, opts.state ?? 'promoted', now, now);
  return id;
}

/** Insert a signal + outbox row (simulating queued-for-promotion). */
function insertSignalWithOutbox(
  db: Database.Database,
  contactId: string,
  contactMatchKey: string,
): string {
  const signalId = insertSignal(db, { contactId, contactMatchKey, state: 'queued' });
  const now = Date.now();
  db
    .prepare(
      'INSERT INTO leadspot_outbox (signal_id, attempts, next_attempt_at, enqueued_at) VALUES (?, 0, ?, ?)',
    )
    .run(signalId, now, now);
  return signalId;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let db: Database.Database;

beforeEach(() => {
  db = openTestDb();
  stampMirrorFresh(db);
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// 1. Signal tombstone
// ---------------------------------------------------------------------------

describe('tombstones — signal type', () => {
  it('redacts the target signal row', async () => {
    const contactId = randomUUID();
    const hash = emailHash('jane@acme.com');
    const signalId = insertSignal(db, { contactId, contactMatchKey: hash, state: 'promoted' });

    const tombstone: TombstoneRow = {
      id: randomUUID(),
      tombstone_type: 'signal',
      signal_id: signalId,
      contact_id: null,
      email_hash: null,
      issued_at: new Date().toISOString(),
    };

    const ctx = makeContext(db, [tombstone]);
    await tickTombstones(ctx);

    const signal = getSignal(db, signalId);
    expect(signal?.state).toBe('redacted');
  });

  it('removes the signal from the outbox when redacting', async () => {
    const contactId = randomUUID();
    const hash = emailHash('bob@enterprise.com');
    const signalId = insertSignalWithOutbox(db, contactId, hash);

    expect(countRows(db, 'leadspot_outbox')).toBe(1);

    const tombstone: TombstoneRow = {
      id: randomUUID(),
      tombstone_type: 'signal',
      signal_id: signalId,
      contact_id: null,
      email_hash: null,
      issued_at: new Date().toISOString(),
    };

    const ctx = makeContext(db, [tombstone]);
    await tickTombstones(ctx);

    expect(countRows(db, 'leadspot_outbox')).toBe(0);
  });

  it('signal tombstone with null signal_id is a no-op (does not throw)', async () => {
    const tombstone: TombstoneRow = {
      id: randomUUID(),
      tombstone_type: 'signal',
      signal_id: null,
      contact_id: null,
      email_hash: null,
      issued_at: new Date().toISOString(),
    };
    const ctx = makeContext(db, [tombstone]);
    await expect(tickTombstones(ctx)).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. Contact tombstone
// ---------------------------------------------------------------------------

describe('tombstones — contact type', () => {
  it('redacts all signals for the contact', async () => {
    const contactId = randomUUID();
    const hash = emailHash('alice@corp.com');
    insertContact(db, { contactId, emailHash: hash, aliases: [hash] });

    const s1 = insertSignal(db, { contactId, contactMatchKey: hash, state: 'promoted' });
    const s2 = insertSignal(db, { contactId, contactMatchKey: hash, state: 'queued' });

    const tombstone: TombstoneRow = {
      id: randomUUID(),
      tombstone_type: 'contact',
      signal_id: null,
      contact_id: contactId,
      email_hash: null,
      issued_at: new Date().toISOString(),
    };

    const ctx = makeContext(db, [tombstone]);
    await tickTombstones(ctx);

    expect(getSignal(db, s1)?.state).toBe('redacted');
    expect(getSignal(db, s2)?.state).toBe('redacted');
  });

  it('removes the contact_mirror entry', async () => {
    const contactId = randomUUID();
    const hash = emailHash('dave@vendor.com');
    insertContact(db, { contactId, emailHash: hash, aliases: [hash] });

    expect(countRows(db, 'contact_mirror')).toBe(1);
    expect(countRows(db, 'email_alias_mirror')).toBe(1);

    const tombstone: TombstoneRow = {
      id: randomUUID(),
      tombstone_type: 'contact',
      signal_id: null,
      contact_id: contactId,
      email_hash: null,
      issued_at: new Date().toISOString(),
    };

    const ctx = makeContext(db, [tombstone]);
    await tickTombstones(ctx);

    expect(countRows(db, 'contact_mirror')).toBe(0);
    expect(countRows(db, 'email_alias_mirror')).toBe(0);
  });

  it('does not affect signals for a different contact', async () => {
    const cA = randomUUID();
    const cB = randomUUID();
    const hashA = emailHash('a@test.com');
    const hashB = emailHash('b@test.com');
    insertContact(db, { contactId: cA, emailHash: hashA, aliases: [hashA] });
    insertContact(db, { contactId: cB, emailHash: hashB, aliases: [hashB] });

    const sA = insertSignal(db, { contactId: cA, contactMatchKey: hashA });
    const sB = insertSignal(db, { contactId: cB, contactMatchKey: hashB });

    const tombstone: TombstoneRow = {
      id: randomUUID(),
      tombstone_type: 'contact',
      signal_id: null,
      contact_id: cA,
      email_hash: null,
      issued_at: new Date().toISOString(),
    };

    const ctx = makeContext(db, [tombstone]);
    await tickTombstones(ctx);

    expect(getSignal(db, sA)?.state).toBe('redacted');
    expect(getSignal(db, sB)?.state).toBe('promoted'); // Unchanged.
  });
});

// ---------------------------------------------------------------------------
// 3. email_hash tombstone
// ---------------------------------------------------------------------------

describe('tombstones — email_hash type', () => {
  it('redacts all signals with that contact_match_key', async () => {
    const hash = emailHash('hans@eu-corp.de');
    const s1 = insertSignal(db, { contactMatchKey: hash, state: 'promoted' });
    const s2 = insertSignal(db, { contactMatchKey: hash, state: 'held_local' });

    const tombstone: TombstoneRow = {
      id: randomUUID(),
      tombstone_type: 'email_hash',
      signal_id: null,
      contact_id: null,
      email_hash: hash,
      issued_at: new Date().toISOString(),
    };

    const ctx = makeContext(db, [tombstone]);
    await tickTombstones(ctx);

    expect(getSignal(db, s1)?.state).toBe('redacted');
    expect(getSignal(db, s2)?.state).toBe('redacted');
  });

  it('removes matching rows from leadspot_unmatched', async () => {
    const hash = emailHash('hans@eu-corp.de');
    db
      .prepare(
        `INSERT INTO leadspot_unmatched
          (id, contact_match_key, source_app, extractor, summary, observed_at, created_at)
         VALUES (?, ?, null, 'explicit_email', 'test', ?, ?)`,
      )
      .run(randomUUID(), hash, Date.now(), Date.now());

    expect(countRows(db, 'leadspot_unmatched')).toBe(1);

    const tombstone: TombstoneRow = {
      id: randomUUID(),
      tombstone_type: 'email_hash',
      signal_id: null,
      contact_id: null,
      email_hash: hash,
      issued_at: new Date().toISOString(),
    };

    const ctx = makeContext(db, [tombstone]);
    await tickTombstones(ctx);

    expect(countRows(db, 'leadspot_unmatched')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Subscription tombstone — wipes all leadspot_* tables
// ---------------------------------------------------------------------------

describe('tombstones — subscription type', () => {
  it('wipes all leadspot tables on subscription tombstone', async () => {
    const contactId = randomUUID();
    const hash = emailHash('mike@company.com');
    insertContact(db, { contactId, emailHash: hash, aliases: [hash] });
    insertSignal(db, { contactId, contactMatchKey: hash, state: 'promoted' });
    insertSignalWithOutbox(db, contactId, hash);

    expect(countRows(db, 'leadspot_signals')).toBeGreaterThan(0);
    expect(countRows(db, 'contact_mirror')).toBe(1);

    const tombstone: TombstoneRow = {
      id: randomUUID(),
      tombstone_type: 'subscription',
      signal_id: null,
      contact_id: null,
      email_hash: null,
      issued_at: new Date().toISOString(),
    };

    const ctx = makeContext(db, [tombstone]);
    await tickTombstones(ctx);

    expect(countRows(db, 'leadspot_signals')).toBe(0);
    expect(countRows(db, 'leadspot_outbox')).toBe(0);
    expect(countRows(db, 'contact_mirror')).toBe(0);
    expect(countRows(db, 'email_alias_mirror')).toBe(0);
    expect(countRows(db, 'self_identity')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Idempotency: same tombstone applied twice → only one effect
// ---------------------------------------------------------------------------

describe('tombstones — idempotency', () => {
  it('signal tombstone applied twice does not crash (no double-redact side effect)', async () => {
    const hash = emailHash('repeat@test.com');
    const signalId = insertSignal(db, { contactMatchKey: hash, state: 'promoted' });

    const tombstone: TombstoneRow = {
      id: 'tombstone-fixed-id-001', // Fixed ID for idempotency test.
      tombstone_type: 'signal',
      signal_id: signalId,
      contact_id: null,
      email_hash: null,
      issued_at: new Date().toISOString(),
    };

    // First application.
    const ctx1 = makeContext(db, [tombstone]);
    await tickTombstones(ctx1);
    expect(getSignal(db, signalId)?.state).toBe('redacted');

    // Second application: the tombstone is already in leadspot_tombstones_seen → skipped.
    const ctx2 = makeContext(db, [tombstone]);
    const result = await tickTombstones(ctx2);
    expect(result.applied).toBe(0); // Dedup: nothing applied again.
    expect(getSignal(db, signalId)?.state).toBe('redacted'); // Unchanged.
  });

  it('tombstones_seen tracks applied tombstone ids', async () => {
    const tombstoneId = 'ts-unique-' + randomUUID();
    const hash = emailHash('track@seen.com');
    const signalId = insertSignal(db, { contactMatchKey: hash, state: 'promoted' });

    const tombstone: TombstoneRow = {
      id: tombstoneId,
      tombstone_type: 'signal',
      signal_id: signalId,
      contact_id: null,
      email_hash: null,
      issued_at: new Date().toISOString(),
    };

    const ctx = makeContext(db, [tombstone]);
    await tickTombstones(ctx);

    const seen = db
      .prepare('SELECT tombstone_id FROM leadspot_tombstones_seen WHERE tombstone_id = ?')
      .get(tombstoneId) as { tombstone_id: string } | undefined;
    expect(seen?.tombstone_id).toBe(tombstoneId);
  });
});

// ---------------------------------------------------------------------------
// 6. Pagination: multi-page tombstone fetch
// ---------------------------------------------------------------------------

describe('tombstones — pagination', () => {
  it('drains multiple pages of tombstones correctly', async () => {
    const hash1 = emailHash('page1@test.com');
    const hash2 = emailHash('page2@test.com');
    const s1 = insertSignal(db, { contactMatchKey: hash1, state: 'promoted' });
    const s2 = insertSignal(db, { contactMatchKey: hash2, state: 'promoted' });

    const t1: TombstoneRow = {
      id: 'ts-page1',
      tombstone_type: 'signal',
      signal_id: s1,
      contact_id: null,
      email_hash: null,
      issued_at: new Date().toISOString(),
    };
    const t2: TombstoneRow = {
      id: 'ts-page2',
      tombstone_type: 'signal',
      signal_id: s2,
      contact_id: null,
      email_hash: null,
      issued_at: new Date().toISOString(),
    };

    const client = makeTombstoneClient([
      { tombstones: [t1], next_since: 'cursor-1' },
      { tombstones: [t2], next_since: null },
    ]);
    const ctx: PromoteContext = {
      db,
      client,
      daemonId: 'test-daemon',
      organizationId: 'test-org',
      notifier: new NoopNotifier(),
    };

    const result = await tickTombstones(ctx);
    expect(result.applied).toBe(2);
    expect(getSignal(db, s1)?.state).toBe('redacted');
    expect(getSignal(db, s2)?.state).toBe('redacted');
  });
});
