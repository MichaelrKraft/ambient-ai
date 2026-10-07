import { describe, expect, it } from 'vitest';
import { parseGoals, parseNotes, parseToday } from '../src/web/deskRoutes.js';

describe('parseNotes', () => {
  it('accepts a well-formed list', () => {
    const out = parseNotes({ notes: [{ id: 'n1', text: 'Call Greg', at: 'Today, 4pm' }] });
    expect(out).toEqual([{ id: 'n1', text: 'Call Greg', at: 'Today, 4pm' }]);
  });

  it('accepts an empty list (clearing every note is legal)', () => {
    expect(parseNotes({ notes: [] })).toEqual([]);
  });

  it('defaults a missing timestamp rather than rejecting', () => {
    const out = parseNotes({ notes: [{ id: 'n1', text: 'x' }] });
    expect(Array.isArray(out)).toBe(true);
    expect((out as { at: string }[])[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('trims surrounding whitespace', () => {
    const out = parseNotes({ notes: [{ id: 'n1', text: '  padded  ' }] });
    expect((out as { text: string }[])[0].text).toBe('padded');
  });

  it('drops unknown fields instead of storing them', () => {
    const out = parseNotes({ notes: [{ id: 'n1', text: 'x', evil: '<script>' }] });
    expect(Object.keys((out as object[])[0]).sort()).toEqual(['at', 'id', 'text']);
  });

  it.each([
    ['not an object', 'body must be a JSON object'],
    [{}, 'notes is required and must be an array'],
    [{ notes: 'nope' }, 'notes is required and must be an array'],
  ])('rejects %s', (body, msg) => {
    expect(parseNotes(body)).toBe(msg);
  });

  it('rejects a note whose text is only whitespace', () => {
    expect(typeof parseNotes({ notes: [{ id: 'n1', text: '   ' }] })).toBe('string');
  });

  it('rejects a note with no id', () => {
    expect(parseNotes({ notes: [{ text: 'orphan' }] })).toBe('note.id is required');
  });

  it('rejects text beyond the cap', () => {
    const out = parseNotes({ notes: [{ id: 'n1', text: 'x'.repeat(4001) }] });
    expect(typeof out).toBe('string');
  });

  // Regression: re-stamping a malformed `at` silently rewrote a note's real
  // creation time to today on every round-trip, so an old thought read as new.
  it('rejects a malformed timestamp instead of silently re-stamping it', () => {
    expect(parseNotes({ notes: [{ id: 'n1', text: 'x', at: 'y'.repeat(200) }] }))
      .toBe('note.at must be a short timestamp string');
  });

  it('still stamps a note that has never had a time', () => {
    const out = parseNotes({ notes: [{ id: 'n1', text: 'x' }] });
    expect((out as { at: string }[])[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('preserves an existing timestamp across a round trip', () => {
    const out = parseNotes({ notes: [{ id: 'n1', text: 'x', at: '2026-09-01T10:00:00.000Z' }] });
    expect((out as { at: string }[])[0].at).toBe('2026-09-01T10:00:00.000Z');
  });

  it('rejects more notes than the cap', () => {
    const notes = Array.from({ length: 501 }, (_, i) => ({ id: `n${i}`, text: 'x' }));
    expect(parseNotes({ notes })).toBe('notes is limited to 500 items');
  });
});

describe('parseGoals', () => {
  const goal = { id: 'g1', name: 'Ship weekly', why: 'compounding', at: '2 of 4', pct: 50 };

  it('accepts goals with achieved omitted', () => {
    const out = parseGoals({ goals: [goal] });
    expect(out).toEqual({ goals: [goal], achieved: [] });
  });

  it('keeps open and achieved lists separate', () => {
    const out = parseGoals({
      goals: [goal],
      achieved: [{ id: 'g9', name: 'Old win', when: 'Today' }],
    });
    expect(out).toMatchObject({
      goals: [{ id: 'g1' }],
      achieved: [{ id: 'g9', name: 'Old win', when: 'Today' }],
    });
  });

  it('clamps a percentage above 100 rather than rejecting the save', () => {
    const out = parseGoals({ goals: [{ ...goal, pct: 250 }] });
    expect((out as { goals: { pct: number }[] }).goals[0].pct).toBe(100);
  });

  it('clamps a negative percentage to zero', () => {
    const out = parseGoals({ goals: [{ ...goal, pct: -5 }] });
    expect((out as { goals: { pct: number }[] }).goals[0].pct).toBe(0);
  });

  it('treats a non-numeric percentage as zero', () => {
    const out = parseGoals({ goals: [{ ...goal, pct: 'lots' }] });
    expect((out as { goals: { pct: number }[] }).goals[0].pct).toBe(0);
  });

  it('rounds a fractional percentage', () => {
    const out = parseGoals({ goals: [{ ...goal, pct: 33.7 }] });
    expect((out as { goals: { pct: number }[] }).goals[0].pct).toBe(34);
  });

  it('allows a goal with no why or progress label', () => {
    const out = parseGoals({ goals: [{ id: 'g1', name: 'Bare' }] });
    expect((out as { goals: unknown[] }).goals[0]).toEqual({
      id: 'g1', name: 'Bare', why: '', at: '', pct: 0,
    });
  });

  it('rejects a goal with no name', () => {
    expect(parseGoals({ goals: [{ id: 'g1' }] })).toBe(
      'goal.name is required and limited to 200 characters',
    );
  });

  it('rejects achieved when it is not an array', () => {
    expect(parseGoals({ goals: [], achieved: 'nope' })).toBe('achieved must be an array');
  });

  it('rejects an achieved entry missing its name', () => {
    expect(parseGoals({ goals: [], achieved: [{ id: 'g9' }] })).toBe(
      'achieved goal needs id and name',
    );
  });

  // Regression: the client unshifts new wins onto the FRONT, so slice(-300)
  // discarded exactly the newest ones and kept the oldest 300 forever.
  it('caps the achieved list, keeping the NEWEST (the client sends newest first)', () => {
    const achieved = Array.from({ length: 320 }, (_, i) => ({ id: `a${i}`, name: `win ${i}` }));
    const out = parseGoals({ goals: [], achieved });
    const rows = (out as { achieved: { name: string }[] }).achieved;
    expect(rows).toHaveLength(300);
    expect(rows[0].name).toBe('win 0');        // newest kept
    expect(rows[299].name).toBe('win 299');
    expect(rows.some((r) => r.name === 'win 319')).toBe(false); // oldest dropped
  });
});

describe('parseToday', () => {
  const good = {
    days: {
      '2026-10-07': {
        top: ['t1', 't2'],
        log: [{ id: 'l1', kind: 'note', text: 'Dave asked about 55 agents', at: '2026-10-07T15:00:00.000Z' }],
        struck: [{ id: 't9', text: 'Old thing' }],
      },
    },
    meta: { t1: { progress: true, moves: 2, scheduled: '2026-10-09' } },
    lastMorning: '2026-10-07',
    notesMigrated: true,
  };

  it('accepts a well-formed state and round-trips it', () => {
    expect(parseToday(good)).toEqual(good);
  });

  it('accepts an empty state', () => {
    expect(parseToday({ days: {}, meta: {}, lastMorning: null })).toEqual({ days: {}, meta: {}, lastMorning: null, notesMigrated: false });
  });

  it('defaults a missing meta and lastMorning', () => {
    expect(parseToday({ days: {} })).toEqual({ days: {}, meta: {}, lastMorning: null, notesMigrated: false });
  });

  it('drops unknown fields', () => {
    const out = parseToday({ days: { '2026-10-07': { top: [], log: [], struck: [], evil: 1 } }, meta: { a: { progress: true, evil: 1 } }, extra: 1 }) as {
      days: Record<string, object>; meta: Record<string, object>;
    };
    expect(Object.keys(out.days['2026-10-07']).sort()).toEqual(['log', 'struck', 'top']);
    expect(Object.keys(out.meta.a)).toEqual(['progress']);
    expect('extra' in out).toBe(false);
  });

  it.each([
    ['not an object', 'body must be a JSON object'],
    [{}, 'days is required and must be an object'],
    [{ days: [] }, 'days is required and must be an object'],
  ])('rejects %s', (body, msg) => {
    expect(parseToday(body)).toBe(msg);
  });

  it('rejects a day key that is not a date', () => {
    expect(parseToday({ days: { 'yesterday': { top: [], log: [], struck: [] } } })).toMatch(/not a YYYY-MM-DD date/);
  });

  it('accepts 100 days and rejects 101 (the client trims to 89; the server only needs a ceiling)', () => {
    const make = (n: number) => {
      const days: Record<string, object> = {};
      for (let i = 0; i < n; i++) days[new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)] = { top: [], log: [], struck: [] };
      return days;
    };
    expect(typeof parseToday({ days: make(100) })).toBe('object');
    expect(parseToday({ days: make(101) })).toBe('days is limited to 100 days');
  });

  it('rejects a non-boolean notesMigrated', () => {
    expect(parseToday({ days: {}, notesMigrated: 'yes' })).toBe('notesMigrated must be true or false');
  });

  it('rejects a fourth top item', () => {
    expect(parseToday({ days: { '2026-10-07': { top: ['a', 'b', 'c', 'd'], log: [], struck: [] } } }))
      .toBe('day 2026-10-07: top is limited to 3 items');
  });

  it('rejects a 31st log entry', () => {
    const log = Array.from({ length: 31 }, (_, i) => ({ id: `l${i}`, kind: 'note', text: 'x', at: '2026-10-07T00:00:00Z' }));
    expect(parseToday({ days: { '2026-10-07': { top: [], log, struck: [] } } })).toBe('day 2026-10-07: log is limited to 30 entries');
  });

  it('rejects a log entry with a bad kind or over-long text', () => {
    const bad = (l: object) => parseToday({ days: { '2026-10-07': { top: [], log: [l], struck: [] } } });
    expect(bad({ id: 'l', kind: 'mood', text: 'x', at: 'a' })).toBe('log entry kind must be note or event');
    expect(bad({ id: 'l', kind: 'note', text: 'x'.repeat(501), at: 'a' })).toBe('log entry text is required and limited to 500 characters');
  });

  it('rejects bad meta values', () => {
    expect(parseToday({ days: {}, meta: { a: { moves: -1 } } })).toBe('meta.moves must be a whole number from 0 to 99');
    expect(parseToday({ days: {}, meta: { a: { scheduled: 'soon' } } })).toBe('meta.scheduled must be a YYYY-MM-DD date');
  });

  it('rejects a bad lastMorning', () => {
    expect(parseToday({ days: {}, lastMorning: 'today' })).toBe('lastMorning must be a YYYY-MM-DD date or null');
  });

  it('keeps __proto__ as plain data instead of polluting anything', () => {
    const out = parseToday(JSON.parse('{"days":{},"meta":{"__proto__":{"progress":true}}}')) as { meta: Record<string, unknown> };
    expect(({} as Record<string, unknown>).progress).toBeUndefined();
    expect(Object.keys(out.meta)).toEqual(['__proto__']);
  });
});
