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

const NOTES_FILE = path.join(os.homedir(), '.ambient', 'desk-notes.json');
const GOALS_FILE = path.join(os.homedir(), '.ambient', 'desk-goals.json');

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
    out.push({ id, text, at: str(n.at, MAX_LABEL) ?? new Date().toISOString() });
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
    // Progress is whatever Mike typed — Desk has no way to derive it, and a
    // made-up number would read as fact. Out-of-range clamps rather than fails.
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
    for (const item of raw.achieved.slice(-MAX_ACHIEVED)) {
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
}
