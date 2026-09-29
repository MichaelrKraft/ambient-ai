import { describe, expect, it, vi } from 'vitest';
import { FastBrain } from '../src/analysis/FastBrain.js';
import type { OcrEntry } from '../src/screenpipe/types.js';

function entry(text: string, app = 'Code', window = 'main.ts', timestamp = '2026-09-28T10:00:00Z'): OcrEntry {
  return { text, appName: app, windowName: window, timestamp };
}

function okResponse(ids: string[], noul = 0.8, cost = 0.00001): Response {
  const answers = Object.fromEntries(ids.map((id) => [id, { noul }]));
  return new Response(JSON.stringify({ answers, usage: { cost } }), { status: 200 });
}

/** Question ids a request body asked, in order. */
function askedIds(fetchMock: ReturnType<typeof vi.fn>, call = 0): string[] {
  const body = JSON.parse((fetchMock.mock.calls[call][1] as RequestInit).body as string);
  return Object.keys(body.questions);
}

describe('FastBrain', () => {
  it('sends the decisions request shape the gate uses: model, zdr, noul questions', async () => {
    const fetchMock = vi.fn(async () => okResponse(['focused_work', 'distraction']));
    const fb = new FastBrain({ apiKey: 'k', fetchImpl: fetchMock as unknown as typeof fetch });

    const { counts, judgments } = await fb.judge([entry('editing FastBrain.ts')], null, 30, 1);

    expect(counts).toMatchObject({ judged: 1, errors: 0, over_cap: 0 });
    expect(judgments[0].pFocusedWork).toBe(0.8);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.model).toBe('~typesafe/jev-latest');
    expect(body.provider).toEqual({ zdr: true });
    expect(body.state.app).toBe('Code');
    for (const q of Object.values(body.questions) as Array<{ type: string }>) expect(q.type).toBe('noul');
  });

  it('asks off_intention only when an intention exists, context_switch only with a previous screen', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      okResponse(Object.keys(JSON.parse(init.body as string).questions)),
    );
    const fb = new FastBrain({ apiKey: 'k', fetchImpl: fetchMock as unknown as typeof fetch });

    await fb.judge([entry('a'), entry('b', 'Safari', 'news')], 'ship FastBrain', 30, 1);
    expect(askedIds(fetchMock, 0)).toEqual(['focused_work', 'distraction', 'off_intention']);
    expect(askedIds(fetchMock, 1)).toEqual(['focused_work', 'distraction', 'context_switch', 'off_intention']);

    fetchMock.mockClear();
    await fb.judge([entry('a')], null, 30, 1);
    expect(askedIds(fetchMock, 0)).toEqual(['focused_work', 'distraction']);
  });

  it('judges each distinct screen once and counts the per-cycle cap', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      okResponse(Object.keys(JSON.parse(init.body as string).questions)),
    );
    const fb = new FastBrain({ apiKey: 'k', fetchImpl: fetchMock as unknown as typeof fetch });

    const entries = [entry('a'), entry('a'), entry('b'), entry('c')]; // 3 distinct
    const { counts } = await fb.judge(entries, null, 2, 1);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(counts.judged).toBe(2);
    expect(counts.over_cap).toBe(1);
  });

  it('stops when the remaining daily budget is spent and counts the rest as over_cap', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      okResponse(Object.keys(JSON.parse(init.body as string).questions), 0.5, 0.02),
    );
    const fb = new FastBrain({ apiKey: 'k', fetchImpl: fetchMock as unknown as typeof fetch });

    // Five workers claim the first five entries before any cost lands, so the
    // cap can overshoot by up to one concurrency batch (acceptable at these
    // prices). With budget == one call's cost, the sixth entry must be skipped.
    const entries = [entry('a'), entry('b'), entry('c'), entry('d'), entry('e'), entry('f')];
    const { counts } = await fb.judge(entries, null, 30, 0.02);

    expect(counts.judged).toBe(5);
    expect(counts.over_cap).toBe(1);
    expect(counts.errors).toBe(0);
  });

  it('counts failures visibly: HTTP errors, timeouts, and missing answers are errors, not zeros', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ answers: { focused_work: { noul: 0.9 } } }), { status: 200 })) // distraction missing
      .mockRejectedValueOnce(new Error('timeout'));
    const fb = new FastBrain({ apiKey: 'k', fetchImpl: fetchMock as unknown as typeof fetch });

    // Concurrency 5 > 3 entries, so each entry gets one mock in some order.
    const { counts, judgments } = await fb.judge([entry('a'), entry('b'), entry('c')], null, 30, 1);

    expect(counts.errors).toBe(3);
    expect(counts.judged).toBe(0);
    expect(judgments).toHaveLength(0);
  });

  it('does nothing without a key', async () => {
    const fetchMock = vi.fn();
    const fb = new FastBrain({ apiKey: undefined, fetchImpl: fetchMock as unknown as typeof fetch });
    const { counts } = await fb.judge([entry('a')], null, 30, 1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(counts.judged).toBe(0);
  });
});
