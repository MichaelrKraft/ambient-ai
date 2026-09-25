import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { looksLikeSecret } from '../src/analysis/taskFilters.js';

// PATHS reads AMBIENT_DB_PATH at import time, so point it at a scratch DB
// before the store is loaded.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-noise-'));
process.env.AMBIENT_DB_PATH = path.join(dir, 'test.db');

vi.mock('../src/notifications/channels.js', () => ({ sendNotification: vi.fn(async () => undefined) }));

type Store = typeof import('../src/storage/AmbientStore.js');
type DbMod = typeof import('../src/storage/db.js');
let store: Store;
let dbMod: DbMod;

beforeAll(async () => {
  dbMod = await import('../src/storage/db.js');
  store = await import('../src/storage/AmbientStore.js');
});

afterAll(() => {
  dbMod.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  const db = dbMod.getDb();
  db.exec('DELETE FROM tasks; DELETE FROM notifications; DELETE FROM error_events;');
});

describe('looksLikeSecret', () => {
  it('catches a truncated OpenRouter key seen in a real auto-task', () => {
    expect(looksLikeSecret('Copy and securely store the OpenRouter API key (sk-or-v1-8f3...)')).toBe(true);
  });

  it('catches a typed password value', () => {
    expect(looksLikeSecret('Log in with password: hunter22')).toBe(true);
  });

  it('leaves ordinary tasks alone, including ones that mention keys', () => {
    expect(looksLikeSecret('Rotate the API key for Done Deal')).toBe(false);
    expect(looksLikeSecret('Review the task-automation plan with Greg')).toBe(false);
    expect(looksLikeSecret('Send the deck to Jenn by Friday')).toBe(false);
  });
});

describe('auto-task storage', () => {
  it('skips a task that holds a secret', () => {
    const id = store.insertTask({ content: 'Store the key sk-or-v1-8f3abc', confidence: 0.9, source: 'auto', accepted: false });
    expect(id).toBeNull();
  });

  it('shows at most 3 suggestions, highest confidence first', () => {
    const tasks = ['Call the lender', 'Send Greg the update', 'Book the inspector', 'Reply to Jenn'];
    tasks.forEach((content, i) => store.insertTask({ content, confidence: 0.7 + i * 0.05, source: 'auto', accepted: false }));
    const shown = store.getSuggestedTasks();
    expect(shown).toHaveLength(3);
    expect(shown[0].content).toBe('Reply to Jenn');
  });

  it('expires suggestions untouched for 7 days, but not accepted tasks', () => {
    const db = dbMod.getDb();
    const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
    store.insertTask({ content: 'Old suggestion nobody touched', confidence: 0.9, source: 'auto', accepted: false });
    store.insertTask({ content: 'Old task the user kept', confidence: 0.9, source: 'auto', accepted: true });
    store.insertTask({ content: 'Fresh suggestion from today', confidence: 0.9, source: 'auto', accepted: false });
    db.prepare(`UPDATE tasks SET created_at = ? WHERE content LIKE 'Old%'`).run(old);

    expect(store.expireStaleSuggestions()).toBe(1);
    const status = (c: string) => (db.prepare('SELECT status FROM tasks WHERE content = ?').get(c) as { status: string }).status;
    expect(status('Old suggestion nobody touched')).toBe('dismissed');
    expect(status('Old task the user kept')).toBe('open');
    expect(status('Fresh suggestion from today')).toBe('open');
  });

  it('reports the share of suggestions kept', () => {
    store.insertTask({ content: 'Kept one', confidence: 0.9, source: 'auto', accepted: true });
    store.insertTask({ content: 'Ignored one', confidence: 0.9, source: 'auto', accepted: false });
    store.insertNotification({ content: 'x', channel: 'system' });
    const q = store.getQualityStats(7);
    expect(q.suggestions).toBe(2);
    expect(q.accepted).toBe(1);
    expect(q.notificationsPerDay).toBeCloseTo(0.1);
  });
});

describe('ProactiveEngine noise limits', () => {
  const baseConfig = (notifications: { stuckErrors: boolean; maxPerDay: number }) =>
    ({ notifications }) as unknown as import('../src/config/index.js').AmbientConfig;

  function addStuckError(text: string): void {
    const longAgo = new Date(Date.now() - 3 * 3_600_000).toISOString();
    dbMod
      .getDb()
      .prepare(
        `INSERT INTO error_events (error_text, app_name, first_seen, last_seen, occurrence_count, is_notified)
         VALUES (?, 'Google Chrome', ?, ?, 3, 0)`,
      )
      .run(text, longAgo, longAgo);
  }

  it('does not send stuck-error alerts when they are off (the default)', async () => {
    const { ProactiveEngine } = await import('../src/notifications/ProactiveEngine.js');
    addStuckError('High memory usage on Gmail tab');
    const fired = await new ProactiveEngine().checkAndNotify(baseConfig({ stuckErrors: false, maxPerDay: 2 }));
    expect(fired).toBe(0);
  });

  it('still sends them when switched on', async () => {
    const { ProactiveEngine } = await import('../src/notifications/ProactiveEngine.js');
    addStuckError('Build failed: TypeError in checkout');
    const fired = await new ProactiveEngine().checkAndNotify(baseConfig({ stuckErrors: true, maxPerDay: 2 }));
    expect(fired).toBe(1);
  });

  it('sends nothing once the daily cap is reached', async () => {
    const { ProactiveEngine } = await import('../src/notifications/ProactiveEngine.js');
    store.insertNotification({ content: 'first', channel: 'system' });
    store.insertNotification({ content: 'second', channel: 'system' });
    addStuckError('Build failed: TypeError in checkout');
    const fired = await new ProactiveEngine().checkAndNotify(baseConfig({ stuckErrors: true, maxPerDay: 2 }));
    expect(fired).toBe(0);
  });
});
