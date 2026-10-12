import { describe, expect, it } from 'vitest';
import { mergeMatrix, parseMatrix } from '../src/web/briefRoutes.js';

type Task = { id: string; text: string; quad: 'do' | 'schedule' | 'delegate' | 'done'; done: boolean };
const t = (id: string, text: string, quad: Task['quad'] = 'do', done = false): Task => ({ id, text, quad, done });
const ids = (tasks: { id: string }[]): string[] => tasks.map((x) => x.id);

describe('mergeMatrix', () => {
  // Regression (2026-09-22): Desk and the morning brief each loaded the matrix
  // once and POSTed their whole list, so whichever saved second silently erased
  // the other's new tasks.
  it('keeps a task added on the other screen when this screen saves from an older copy', () => {
    const base = [t('a', 'Existing')];
    const current = [t('a', 'Existing'), t('desk1', 'Added in Desk')];
    const local = [t('a', 'Existing'), t('brief1', 'Added in the brief')];
    expect(ids(mergeMatrix(base, local, current).tasks)).toEqual(['a', 'desk1', 'brief1']);
  });

  it('applies a deletion made on this screen', () => {
    const base = [t('a', 'A'), t('b', 'B')];
    const current = [t('a', 'A'), t('b', 'B'), t('c', 'C')];
    const local = [t('a', 'A')];
    expect(ids(mergeMatrix(base, local, current).tasks)).toEqual(['a', 'c']);
  });

  it('keeps a deletion made on the other screen when this screen did not touch the task', () => {
    const base = [t('a', 'A'), t('b', 'B')];
    const current = [t('a', 'A')];
    const local = [t('a', 'A'), t('b', 'B')];
    expect(ids(mergeMatrix(base, local, current).tasks)).toEqual(['a']);
  });

  it('keeps an edit made on the other screen when this screen did not touch the task', () => {
    const base = [t('a', 'A', 'do')];
    const current = [t('a', 'A', 'schedule')];
    const local = [t('a', 'A', 'do')];
    expect(mergeMatrix(base, local, current).tasks[0].quad).toBe('schedule');
  });

  it('lets this screen win when both screens changed the same task', () => {
    const base = [t('a', 'A', 'do')];
    const current = [t('a', 'A', 'schedule')];
    const local = [t('a', 'A', 'done', true)];
    expect(mergeMatrix(base, local, current).tasks[0]).toMatchObject({ quad: 'done', done: true });
  });

  // Regression (matrix-reorder, 2026-10-11): order is the array order, but the
  // merge used the server's order, so a reorder saved from a stale screen reverted.
  it('applies a reorder made on this screen when the server copy changed elsewhere', () => {
    const base = [t('a', 'A'), t('b', 'B'), t('c', 'C')];
    const current = [t('a', 'A'), t('b', 'B'), t('c', 'C'), t('d', 'D')];
    const local = [t('c', 'C'), t('a', 'A'), t('b', 'B')];
    expect(ids(mergeMatrix(base, local, current).tasks)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('keeps the server order when this screen did not reorder anything', () => {
    const base = [t('a', 'A'), t('b', 'B')];
    const current = [t('b', 'B'), t('a', 'A')];
    const local = [t('a', 'A'), t('b', 'B')];
    expect(ids(mergeMatrix(base, local, current).tasks)).toEqual(['b', 'a']);
  });

  it('puts a task added elsewhere before its next neighbour when this screen reorders', () => {
    const base = [t('a', 'A'), t('b', 'B'), t('c', 'C')];
    const current = [t('a', 'A'), t('x', 'X'), t('b', 'B'), t('c', 'C')];
    const local = [t('c', 'C'), t('b', 'B'), t('a', 'A')];
    expect(ids(mergeMatrix(base, local, current).tasks)).toEqual(['c', 'x', 'b', 'a']);
  });

  it('does not bring back a task deleted elsewhere when this screen reorders', () => {
    const base = [t('a', 'A'), t('b', 'B'), t('c', 'C')];
    const current = [t('a', 'A'), t('c', 'C')];
    const local = [t('c', 'C'), t('b', 'B'), t('a', 'A')];
    expect(ids(mergeMatrix(base, local, current).tasks)).toEqual(['c', 'a']);
  });

  it('unions dismissed suggestions from both screens', () => {
    const out = mergeMatrix([], [], [], { base: ['x'], local: ['x', 'y'], current: ['x', 'z'] });
    expect(out.dismissed.sort()).toEqual(['x', 'y', 'z']);
  });
});

describe('parseMatrix', () => {
  it('requires the base copy so an out-of-date page cannot overwrite the list', () => {
    expect(parseMatrix({ tasks: [], dismissed: [] })).toMatch(/base/);
  });

  it('accepts a first save against an empty server (base.updatedAt null)', () => {
    const out = parseMatrix({ tasks: [t('a', 'A')], dismissed: [], base: { tasks: [], dismissed: [], updatedAt: null } });
    expect(typeof out).toBe('object');
  });
});
