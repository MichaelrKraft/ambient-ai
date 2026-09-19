import { describe, expect, it } from 'vitest';
import { parseGoals, parseNotes } from '../src/web/deskRoutes.js';

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
