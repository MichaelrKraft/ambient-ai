import { describe, it, expect, vi } from 'vitest';
import { PrivacyGate, WITHHELD_TEXT, WITHHELD_WINDOW } from '../src/analysis/PrivacyGate.js';
import type { OcrEntry } from '../src/screenpipe/types.js';

const entry = (text: string, windowName = 'Please print for Mayla - Gmail', appName = 'Google Chrome'): OcrEntry => ({
  text,
  appName,
  windowName,
  timestamp: '2026-09-24T12:00:00Z',
});

function jevReturning(scores: Record<string, unknown>): typeof fetch {
  const answers = Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, { type: 'noul', noul: v }]));
  return vi.fn(async () => new Response(JSON.stringify({ answers }), { status: 200 })) as unknown as typeof fetch;
}

const LOW = { personal_info: 0.1, financial: 0.1, credential: 0.1, never_record: 0.1 };

describe('PrivacyGate', () => {
  it('passes an entry when every score is below the threshold', async () => {
    const gate = new PrivacyGate({ apiKey: 'k', fetchImpl: jevReturning(LOW) });
    const r = await gate.screen([entry('A news article about the Broncos')]);
    expect(r.counts).toEqual({ passed: 1, private: 0, error: 0, over_cap: 0 });
    expect(r.entries[0].text).toBe('A news article about the Broncos');
    expect(r.passed).toHaveLength(1);
  });

  it('withholds when any one score reaches the threshold', async () => {
    const gate = new PrivacyGate({ apiKey: 'k', fetchImpl: jevReturning({ ...LOW, never_record: 0.4 }) });
    const r = await gate.screen([entry('Invoice for Kane Phase 1')]);
    expect(r.counts.private).toBe(1);
    expect(r.passed).toHaveLength(0);
  });

  it('replaces the window title too, because titles leak on their own', async () => {
    const gate = new PrivacyGate({ apiKey: 'k', fetchImpl: jevReturning({ ...LOW, personal_info: 0.9 }) });
    const r = await gate.screen([entry('school form')]);
    expect(r.entries[0]).toMatchObject({ appName: 'Google Chrome', windowName: WITHHELD_WINDOW, text: WITHHELD_TEXT });
    expect(JSON.stringify(r.entries)).not.toContain('Mayla');
  });

  it('fails closed when the API key is missing, without calling out', async () => {
    const fetchImpl = jevReturning(LOW);
    const gate = new PrivacyGate({ apiKey: undefined, fetchImpl });
    const r = await gate.screen([entry('anything')]);
    expect(r.counts.error).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed on an HTTP error', async () => {
    const fetchImpl = vi.fn(async () => new Response('down', { status: 503 })) as unknown as typeof fetch;
    const r = await new PrivacyGate({ apiKey: 'k', fetchImpl }).screen([entry('anything')]);
    expect(r.counts.error).toBe(1);
  });

  it('fails closed when fetch throws (network error or timeout)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('aborted');
    }) as unknown as typeof fetch;
    const r = await new PrivacyGate({ apiKey: 'k', fetchImpl }).screen([entry('anything')]);
    expect(r.counts.error).toBe(1);
  });

  it('treats a missing or non-numeric answer as a failure, not a "no"', async () => {
    const gate = new PrivacyGate({ apiKey: 'k', fetchImpl: jevReturning({ personal_info: 0.1, financial: 'n/a' }) });
    const r = await gate.screen([entry('anything')]);
    expect(r.counts.error).toBe(1);
  });

  it('checks identical screens once and keeps input order', async () => {
    const fetchImpl = jevReturning(LOW);
    const gate = new PrivacyGate({ apiKey: 'k', fetchImpl });
    const same = entry('same text', 'Win');
    const r = await gate.screen([same, entry('other', 'Win2'), { ...same, timestamp: 'later' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(r.entries.map((e) => e.text)).toEqual(['same text', 'other', 'same text']);
  });

  it('regex-scrubs text before it is sent to the checker', async () => {
    const fetchImpl = jevReturning(LOW);
    await new PrivacyGate({ apiKey: 'k', fetchImpl }).screen([entry('card 4111 1111 1111 1111 on file')]);
    const body = String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body).not.toContain('4111 1111');
    expect(body).toContain('"zdr":true');
  });
});
