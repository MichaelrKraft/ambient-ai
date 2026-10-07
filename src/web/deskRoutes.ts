/**
 * deskRoutes — storage for the Desk app's Notes and Goals tabs.
 *
 * Desk (~/desk) is a floating panel Mike summons with Cmd+Shift+Space. Its
 * Matrix tab deliberately reuses /api/brief/matrix so the desktop panel, the
 * morning brief and the voice Chief of Staff all read ONE task list. Notes and
 * goals have no such home, so they get one here:
 *
 *   GET  /api/desk/notes  → { notes: [...], updatedAt }
 *   POST /api/desk/notes  → replace the whole list
 *   GET  /api/desk/goals  → { goals: [...], achieved: [...], updatedAt }
 *   POST /api/desk/goals  → replace both lists
 *   GET  /api/desk/today  → { days, meta, lastMorning, notesMigrated, updatedAt }
 *   POST /api/desk/today  → replace the whole Today state (2 MB parser)
 *
 * Writes replace rather than merge: the panel is a single-user surface that
 * always holds the full list, and replace makes a lost race obvious instead of
 * silently resurrecting a deleted row.
 *
 * Trust model matches briefRoutes: bound to 127.0.0.1, CORS open to exactly
 * this server and "null" (what Chrome sends for a file:// page), every field
 * validated and clamped, nothing executed, no note or goal text in any log.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { DAEMON_PORT } from '../config/paths.js';
import { createLogger } from '../shared/logger.js';

interface Note {
  id: string;
  text: string;
  at: string;
}

interface Goal {
  id: string;
  name: string;
  why: string;
  at: string;
  pct: number;
}

interface AchievedGoal {
  id: string;
  name: string;
  when: string;
}

const MAX_NOTES = 500;
const MAX_NOTE_TEXT = 4000;
const MAX_GOALS = 100;
const MAX_ACHIEVED = 300;
const MAX_NAME = 200;
const MAX_WHY = 600;
const MAX_LABEL = 80;
const MAX_ID = 40;

const MAX_TODAY_DAYS = 100; // a ceiling only: the client trims to 89 days
const MAX_TOP = 3;
const MAX_LOG = 30;
const MAX_STRUCK = 50;
const MAX_TODAY_TEXT = 500;
const MAX_META = 400;
const MAX_MOVES = 99;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface TodayLogEntry { id: string; kind: 'note' | 'event'; text: string; at: string }
interface TodayDay { top: string[]; log: TodayLogEntry[]; struck: { id: string; text: string }[] }
interface TodayMeta { progress?: true; moves?: number; scheduled?: string }
export interface TodayState {
  days: Record<string, TodayDay>;
  meta: Record<string, TodayMeta>;
  lastMorning: string | null;
  notesMigrated: boolean;
}

const NOTES_FILE = path.join(os.homedir(), '.ambient', 'desk-notes.json');
const GOALS_FILE = path.join(os.homedir(), '.ambient', 'desk-goals.json');
const TODAY_FILE = path.join(os.homedir(), '.ambient', 'desk-today.json');

/** Write via temp + rename so a reader never sees a half-written file. */
function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    // A corrupt file must not take the panel down; the next write heals it.
    return fallback;
  }
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > max) return null;
  return s;
}

/** Returns the clean list, or a string naming the first problem. */
export function parseNotes(body: unknown): Note[] | string {
  if (typeof body !== 'object' || body === null) return 'body must be a JSON object';
  const raw = (body as Record<string, unknown>).notes;
  if (!Array.isArray(raw)) return 'notes is required and must be an array';
  if (raw.length > MAX_NOTES) return `notes is limited to ${MAX_NOTES} items`;

  const out: Note[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return 'each note must be an object';
    const n = item as Record<string, unknown>;
    const id = str(n.id, MAX_ID);
    const text = str(n.text, MAX_NOTE_TEXT);
    if (!id) return 'note.id is required';
    if (!text) return `note.text is required and limited to ${MAX_NOTE_TEXT} characters`;
    // Only stamp a note that has never had a time. Re-stamping a malformed one
    // would silently rewrite its real creation time to "today" on every save,
    // and the panel would then show an old thought as if it were new.
    const at = str(n.at, MAX_LABEL);
    if (n.at !== undefined && at === null) return 'note.at must be a short timestamp string';
    out.push({ id, text, at: at ?? new Date().toISOString() });
  }
  return out;
}

export function parseGoals(body: unknown): { goals: Goal[]; achieved: AchievedGoal[] } | string {
  if (typeof body !== 'object' || body === null) return 'body must be a JSON object';
  const raw = body as Record<string, unknown>;
  if (!Array.isArray(raw.goals)) return 'goals is required and must be an array';
  if (raw.goals.length > MAX_GOALS) return `goals is limited to ${MAX_GOALS} items`;

  const goals: Goal[] = [];
  for (const item of raw.goals) {
    if (typeof item !== 'object' || item === null) return 'each goal must be an object';
    const g = item as Record<string, unknown>;
    const id = str(g.id, MAX_ID);
    const name = str(g.name, MAX_NAME);
    if (!id) return 'goal.id is required';
    if (!name) return `goal.name is required and limited to ${MAX_NAME} characters`;
    // `at`/`pct` are legacy: the panel dropped progress tracking (2026-09-18)
    // because entering the same fact twice produced goals stuck at 1%, and a
    // percentage nobody updates is worse than none. Still accepted so a goal
    // saved by the older build round-trips instead of failing validation.
    const pctRaw = typeof g.pct === 'number' && Number.isFinite(g.pct) ? g.pct : 0;
    goals.push({
      id,
      name,
      why: str(g.why, MAX_WHY) ?? '',
      at: str(g.at, MAX_LABEL) ?? '',
      pct: Math.max(0, Math.min(100, Math.round(pctRaw))),
    });
  }

  const achieved: AchievedGoal[] = [];
  if (raw.achieved !== undefined) {
    if (!Array.isArray(raw.achieved)) return 'achieved must be an array';
    // The client unshifts new wins onto the FRONT, so the newest are first.
    // slice(-MAX) would have discarded exactly those and kept the oldest.
    for (const item of raw.achieved.slice(0, MAX_ACHIEVED)) {
      if (typeof item !== 'object' || item === null) return 'each achieved goal must be an object';
      const a = item as Record<string, unknown>;
      const id = str(a.id, MAX_ID);
      const name = str(a.name, MAX_NAME);
      if (!id || !name) return 'achieved goal needs id and name';
      achieved.push({ id, name, when: str(a.when, MAX_LABEL) ?? '' });
    }
  }
  return { goals, achieved };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Returns the clean Today state, or a string naming the first problem. */
export function parseToday(body: unknown): TodayState | string {
  if (typeof body !== 'object' || body === null) return 'body must be a JSON object';
  const raw = body as Record<string, unknown>;
  if (!isPlainObject(raw.days)) return 'days is required and must be an object';
  const keys = Object.keys(raw.days);
  if (keys.length > MAX_TODAY_DAYS) return `days is limited to ${MAX_TODAY_DAYS} days`;

  // Null-prototype objects: a key like "__proto__" stays plain data.
  const days: Record<string, TodayDay> = Object.create(null);
  for (const key of keys) {
    if (!DATE_RE.test(key)) return `day key "${key.slice(0, 20)}" is not a YYYY-MM-DD date`;
    const d = raw.days[key];
    if (!isPlainObject(d)) return `day ${key} must be an object`;

    const topRaw = d.top ?? [];
    if (!Array.isArray(topRaw)) return `day ${key}: top must be an array`;
    if (topRaw.length > MAX_TOP) return `day ${key}: top is limited to ${MAX_TOP} items`;
    const top: string[] = [];
    for (const id of topRaw) {
      const s = str(id, MAX_ID);
      if (!s) return `day ${key}: top ids must be short strings`;
      top.push(s);
    }

    const logRaw = d.log ?? [];
    if (!Array.isArray(logRaw)) return `day ${key}: log must be an array`;
    if (logRaw.length > MAX_LOG) return `day ${key}: log is limited to ${MAX_LOG} entries`;
    const log: TodayLogEntry[] = [];
    for (const item of logRaw) {
      if (!isPlainObject(item)) return 'each log entry must be an object';
      if (item.kind !== 'note' && item.kind !== 'event') return 'log entry kind must be note or event';
      const id = str(item.id, MAX_ID);
      const text = str(item.text, MAX_TODAY_TEXT);
      const at = str(item.at, MAX_LABEL);
      if (!id) return 'log entry id is required';
      if (!text) return `log entry text is required and limited to ${MAX_TODAY_TEXT} characters`;
      if (!at) return 'log entry at must be a short timestamp string';
      log.push({ id, kind: item.kind, text, at });
    }

    const struckRaw = d.struck ?? [];
    if (!Array.isArray(struckRaw)) return `day ${key}: struck must be an array`;
    if (struckRaw.length > MAX_STRUCK) return `day ${key}: struck is limited to ${MAX_STRUCK} items`;
    const struck: { id: string; text: string }[] = [];
    for (const item of struckRaw) {
      if (!isPlainObject(item)) return 'each struck item must be an object';
      const id = str(item.id, MAX_ID);
      const text = str(item.text, MAX_TODAY_TEXT);
      if (!id || !text) return 'struck item needs id and text';
      struck.push({ id, text });
    }
    days[key] = { top, log, struck };
  }

  const meta: Record<string, TodayMeta> = Object.create(null);
  if (raw.meta !== undefined) {
    if (!isPlainObject(raw.meta)) return 'meta must be an object';
    const ids = Object.keys(raw.meta);
    if (ids.length > MAX_META) return `meta is limited to ${MAX_META} tasks`;
    for (const id of ids) {
      if (!str(id, MAX_ID)) return 'meta keys must be task ids';
      const m = raw.meta[id];
      if (!isPlainObject(m)) return 'each meta entry must be an object';
      const out: TodayMeta = {};
      if (m.progress === true) out.progress = true;
      if (m.moves !== undefined) {
        if (typeof m.moves !== 'number' || !Number.isInteger(m.moves) || m.moves < 0 || m.moves > MAX_MOVES) {
          return `meta.moves must be a whole number from 0 to ${MAX_MOVES}`;
        }
        out.moves = m.moves;
      }
      if (m.scheduled !== undefined) {
        if (typeof m.scheduled !== 'string' || !DATE_RE.test(m.scheduled)) return 'meta.scheduled must be a YYYY-MM-DD date';
        out.scheduled = m.scheduled;
      }
      meta[id] = out;
    }
  }

  let lastMorning: string | null = null;
  if (raw.lastMorning !== undefined && raw.lastMorning !== null) {
    if (typeof raw.lastMorning !== 'string' || !DATE_RE.test(raw.lastMorning)) return 'lastMorning must be a YYYY-MM-DD date or null';
    lastMorning = raw.lastMorning;
  }
  if (raw.notesMigrated !== undefined && typeof raw.notesMigrated !== 'boolean') return 'notesMigrated must be true or false';
  return { days, meta, lastMorning, notesMigrated: raw.notesMigrated === true };
}

export function registerDeskRoutes(app: Express): void {
  const log = createLogger('desk');
  const allowedOrigins = new Set([
    'null',
    `http://localhost:${DAEMON_PORT}`,
    `http://127.0.0.1:${DAEMON_PORT}`,
  ]);

  const cors = (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };

  // Today keeps 90 days of logs, so it gets its own larger parser first.
  app.use('/api/desk/today', cors, express.json({ limit: '2mb' }));

  // Own parser, larger than the global 16kb: 500 notes of prose.
  app.use('/api/desk', cors, express.json({ limit: '512kb' }));

  app.get('/api/desk/notes', (_req: Request, res: Response) => {
    res.json(readJson(NOTES_FILE, { notes: [], updatedAt: null }));
  });

  app.post('/api/desk/notes', (req: Request, res: Response) => {
    const notes = parseNotes(req.body);
    if (typeof notes === 'string') {
      res.status(400).json({ error: notes });
      return;
    }
    const state = { notes, updatedAt: new Date().toISOString() };
    try {
      fs.mkdirSync(path.dirname(NOTES_FILE), { recursive: true });
      writeAtomic(NOTES_FILE, JSON.stringify(state, null, 2));
      log.info(`notes saved: ${notes.length}`); // count only — never the text
      res.json({ ok: true, updatedAt: state.updatedAt });
    } catch (err) {
      log.error('POST /api/desk/notes failed', err);
      res.status(500).json({ error: 'Could not save your notes' });
    }
  });

  app.get('/api/desk/goals', (_req: Request, res: Response) => {
    res.json(readJson(GOALS_FILE, { goals: [], achieved: [], updatedAt: null }));
  });

  app.post('/api/desk/goals', (req: Request, res: Response) => {
    const parsed = parseGoals(req.body);
    if (typeof parsed === 'string') {
      res.status(400).json({ error: parsed });
      return;
    }
    const state = { ...parsed, updatedAt: new Date().toISOString() };
    try {
      fs.mkdirSync(path.dirname(GOALS_FILE), { recursive: true });
      writeAtomic(GOALS_FILE, JSON.stringify(state, null, 2));
      log.info(`goals saved: ${parsed.goals.length} open, ${parsed.achieved.length} achieved`);
      res.json({ ok: true, updatedAt: state.updatedAt });
    } catch (err) {
      log.error('POST /api/desk/goals failed', err);
      res.status(500).json({ error: 'Could not save your goals' });
    }
  });

  app.get('/api/desk/today', (_req: Request, res: Response) => {
    res.json(readJson(TODAY_FILE, { days: {}, meta: {}, lastMorning: null, notesMigrated: false, updatedAt: null }));
  });

  app.post('/api/desk/today', (req: Request, res: Response) => {
    const parsed = parseToday(req.body);
    if (typeof parsed === 'string') {
      res.status(400).json({ error: parsed });
      return;
    }
    const state = { ...parsed, updatedAt: new Date().toISOString() };
    try {
      fs.mkdirSync(path.dirname(TODAY_FILE), { recursive: true });
      writeAtomic(TODAY_FILE, JSON.stringify(state));
      log.info(`today saved: ${Object.keys(parsed.days).length} days, ${Object.keys(parsed.meta).length} tasks`); // counts only
      res.json({ ok: true, updatedAt: state.updatedAt });
    } catch (err) {
      log.error('POST /api/desk/today failed', err);
      res.status(500).json({ error: 'Could not save Today' });
    }
  });

  // Over the 2 MB limit body-parser throws; say so in plain words instead of a bare 413.
  app.use('/api/desk/today', (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.too.large') {
      res.status(400).json({ error: 'Too much saved history to store. Oldest days are trimmed on the next save.' });
      return;
    }
    next(err);
  });
}
