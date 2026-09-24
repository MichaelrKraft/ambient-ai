import { describe, it, expect } from 'vitest';
import { ChangeDetector, MAX_CONSECUTIVE_SKIPS } from '../src/analysis/ChangeDetector.js';
import type { OcrEntry } from '../src/screenpipe/types.js';

const DOC =
  'Quarterly planning notes for the Ambient roadmap covering privacy gate rollout dashboard redesign and client install checklist';

const entry = (text: string, windowName = 'Roadmap - Google Docs', appName = 'Google Chrome'): OcrEntry => ({
  text,
  appName,
  windowName,
  timestamp: '2026-09-24T12:00:00Z',
});

describe('ChangeDetector', () => {
  it('always runs the first cycle', () => {
    expect(new ChangeDetector().shouldSkip([entry(DOC)])).toBe(false);
  });

  it('skips when the same doc is still on screen', () => {
    const d = new ChangeDetector();
    d.shouldSkip([entry(DOC)]);
    expect(d.shouldSkip([entry(DOC)])).toBe(true);
  });

  it('ignores digits, so a clock or video timer is not a change', () => {
    const d = new ChangeDetector();
    d.shouldSkip([entry(`${DOC} 12:41 PM 3:05 / 42:10`)]);
    expect(d.shouldSkip([entry(`${DOC} 12:48 PM 10:12 / 42:10`)])).toBe(true);
  });

  it('runs when the window changes, even with similar text', () => {
    const d = new ChangeDetector();
    d.shouldSkip([entry(DOC)]);
    expect(d.shouldSkip([entry(DOC, 'Roadmap v2 - Google Docs')])).toBe(false);
  });

  it('runs when a new app appears alongside the old one', () => {
    const d = new ChangeDetector();
    d.shouldSkip([entry(DOC)]);
    expect(d.shouldSkip([entry(DOC), entry('build output', 'zsh', 'Terminal')])).toBe(false);
  });

  it('runs when most of the text is new', () => {
    const d = new ChangeDetector();
    d.shouldSkip([entry(DOC)]);
    expect(d.shouldSkip([entry('Invoice draft for Kane phase two with line items totals and payment terms')])).toBe(false);
  });

  it(`forces a real analysis after ${MAX_CONSECUTIVE_SKIPS} skips in a row`, () => {
    const d = new ChangeDetector();
    d.shouldSkip([entry(DOC)]);
    for (let i = 0; i < MAX_CONSECUTIVE_SKIPS; i++) expect(d.shouldSkip([entry(DOC)])).toBe(true);
    expect(d.shouldSkip([entry(DOC)])).toBe(false);
    expect(d.shouldSkip([entry(DOC)])).toBe(true);
  });

  it('runs again after reset', () => {
    const d = new ChangeDetector();
    d.shouldSkip([entry(DOC)]);
    d.reset();
    expect(d.shouldSkip([entry(DOC)])).toBe(false);
  });
});
