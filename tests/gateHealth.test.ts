import { describe, it, expect, vi } from 'vitest';
import { GateHealthMonitor } from '../src/analysis/GateHealthMonitor.js';
import { PrivacyGate } from '../src/analysis/PrivacyGate.js';
import type { OcrEntry } from '../src/screenpipe/types.js';

const counts = (c: Partial<{ passed: number; private: number; error: number; over_cap: number }>) => ({
  passed: 0,
  private: 0,
  error: 0,
  over_cap: 0,
  ...c,
});

const HOUR = 3_600_000;

describe('GateHealthMonitor (2026-10-08 OpenRouter 402 outage, 2 days unnoticed)', () => {
  it('alerts on the FIRST cycle when the cause is a billing/auth failure', () => {
    const m = new GateHealthMonitor({ now: () => 0 });
    const e = m.observe(counts({ error: 114 }), { http_402: 114 });
    expect(e?.kind).toBe('alert');
    expect(e && 'message' in e ? e.message : '').toContain('402');
  });

  it('waits for two bad cycles before alerting on a non-billing failure', () => {
    const m = new GateHealthMonitor({ now: () => 0 });
    expect(m.observe(counts({ error: 40 }), { network: 40 })).toBeNull();
    expect(m.observe(counts({ error: 40 }), { network: 40 })?.kind).toBe('alert');
  });

  it('does not alert when most screens pass or are judged private', () => {
    const m = new GateHealthMonitor({ now: () => 0 });
    expect(m.observe(counts({ passed: 42, private: 10 }), {})).toBeNull();
    expect(m.observe(counts({ passed: 5, error: 3 }), { network: 3 })).toBeNull();
  });

  it('ignores tiny cycles, which carry no signal', () => {
    const m = new GateHealthMonitor({ now: () => 0 });
    expect(m.observe(counts({ error: 2 }), { http_402: 2 })).toBeNull();
  });

  it('throttles repeat alerts to one per cooldown window', () => {
    let t = 0;
    const m = new GateHealthMonitor({ now: () => t });
    expect(m.observe(counts({ error: 50 }), { http_402: 50 })?.kind).toBe('alert');
    t += 7 * 60_000;
    expect(m.observe(counts({ error: 50 }), { http_402: 50 })).toBeNull();
    t += 6 * HOUR;
    expect(m.observe(counts({ error: 50 }), { http_402: 50 })?.kind).toBe('alert');
  });

  it('reports recovery once after an alert, then stays quiet', () => {
    const m = new GateHealthMonitor({ now: () => 0 });
    m.observe(counts({ error: 50 }), { http_402: 50 });
    expect(m.observe(counts({ passed: 40, private: 10 }), {})?.kind).toBe('recovered');
    expect(m.observe(counts({ passed: 40, private: 10 }), {})).toBeNull();
  });
});

describe('PrivacyGate failure causes', () => {
  const entry: OcrEntry = { text: 'hello', appName: 'Terminal', windowName: 'zsh', timestamp: '2026-10-08T12:00:00Z' };

  it('records the HTTP status instead of collapsing everything to "error"', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 402 })) as unknown as typeof fetch;
    const r = await new PrivacyGate({ apiKey: 'k', fetchImpl }).screen([entry]);
    expect(r.counts.error).toBe(1);
    expect(r.errorCauses).toEqual({ http_402: 1 });
  });

  it('labels network failures and a missing key', async () => {
    const boom = vi.fn(async () => {
      throw new Error('fetch failed');
    }) as unknown as typeof fetch;
    expect((await new PrivacyGate({ apiKey: 'k', fetchImpl: boom }).screen([entry])).errorCauses).toEqual({ network: 1 });
    expect((await new PrivacyGate({ apiKey: undefined }).screen([entry])).errorCauses).toEqual({ no_key: 1 });
  });
});
