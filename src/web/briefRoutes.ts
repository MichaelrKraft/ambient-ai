/**
 * briefRoutes — write endpoints for the morning brief page.
 *
 * The brief is a static HTML file, usually opened as file://, so it cannot
 * write to disk itself. Until 2026-09-18 that meant the Eisenhower matrix lived
 * only in Chrome's localStorage and improve-system sign-offs could not be ticked
 * from the page. These routes give the page somewhere to save:
 *
 *   GET  /api/brief/matrix   → last saved matrix state (or { tasks: [] })
 *   POST /api/brief/matrix   → persist state
 *   POST /api/brief/review   → tick Approve/Reject on one item of an
 *                              improve-system review file in the vault
 *
 * Trust model: the server binds to 127.0.0.1. CORS is opened to exactly two
 * origins — this server, and "null" (what Chrome sends for a file:// page).
 * Every input is validated and every path is confined to a fixed directory;
 * nothing here executes anything or returns file contents.
 *
 * Logging: outcomes and counts only — never task text (it is personal).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { DAEMON_PORT } from '../config/paths.js';
import { createLogger } from '../shared/logger.js';

const QUADS = ['do', 'schedule', 'delegate', 'done'] as const;
type Quad = (typeof QUADS)[number];

interface MatrixTask {
  id: string;
  text: string;
  quad: Quad;
  done: boolean;
  from?: Quad;
  added?: string;
  finished?: string;
}

interface MatrixState {
  tasks: MatrixTask[];
  dismissed: string[];
  updatedAt: string;
}

const MAX_TASKS = 200;
const MAX_TEXT = 300;
const MAX_DISMISSED = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REVIEW_FILE_RE = /^\d{4}-\d{2}-\d{2}[\w-]*\.md$/;
const REVIEW_KEY_RE = /^[a-z0-9][a-z0-9-]{1,80}$/;

const STATE_FILE = path.join(os.homedir(), '.ambient', 'brief-matrix.json');
// The vault lives OUTSIDE ~/Documents on purpose: macOS blocks background jobs
// from reading Documents ("Operation not permitted"), which silently broke every
// scheduled job that touched the vault.
const DEFAULT_REVIEWS_DIR = path.join(os.homedir(), 'ObsidianVault', 'Output', 'reviews');

function isQuad(v: unknown): v is Quad {
  return typeof v === 'string' && (QUADS as readonly string[]).includes(v);
}

/**
 * What a POST carries. `base` is the server copy the page last saw — without
 * it the server cannot tell "Mike deleted this" from "this page never heard of
 * it", and a page left open for days would erase everything added elsewhere.
 */
export interface MatrixSave {
  tasks: MatrixTask[];
  dismissed: string[];
  base: { tasks: MatrixTask[]; dismissed: string[]; updatedAt: string | null };
}

/** Returns a clean save, or a string describing the first problem found. */
export function parseMatrix(body: unknown): MatrixSave | string {
  if (typeof body !== 'object' || body === null) return 'body must be a JSON object';
  const raw = body as Record<string, unknown>;
  const tasks = parseTasks(raw.tasks);
  if (typeof tasks === 'string') return tasks;

  if (typeof raw.base !== 'object' || raw.base === null) {
    return 'base is required — this page is out of date, reload it';
  }
  const rawBase = raw.base as Record<string, unknown>;
  const baseTasks = parseTasks(rawBase.tasks);
  if (typeof baseTasks === 'string') return `base: ${baseTasks}`;
  if (rawBase.updatedAt !== null && typeof rawBase.updatedAt !== 'string') return 'base.updatedAt must be a string or null';

  return {
    tasks,
    dismissed: parseDismissed(raw.dismissed),
    base: { tasks: baseTasks, dismissed: parseDismissed(rawBase.dismissed), updatedAt: rawBase.updatedAt },
  };
}

function parseDismissed(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((d): d is string => typeof d === 'string' && d.length <= MAX_TEXT).slice(-MAX_DISMISSED)
    : [];
}

function parseTasks(raw: unknown): MatrixTask[] | string {
  if (!Array.isArray(raw)) return 'tasks is required and must be an array';
  if (raw.length > MAX_TASKS) return `tasks is limited to ${MAX_TASKS} items`;

  const tasks: MatrixTask[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return 'each task must be an object';
    const t = item as Record<string, unknown>;
    if (typeof t.id !== 'string' || !t.id || t.id.length > 40) return 'task.id is required';
    if (typeof t.text !== 'string' || !t.text.trim()) return 'task.text is required';
    if (t.text.length > MAX_TEXT) return `task.text is limited to ${MAX_TEXT} characters`;
    if (!isQuad(t.quad)) return 'task.quad must be do, schedule, delegate or done';
    const task: MatrixTask = { id: t.id, text: t.text.trim(), quad: t.quad, done: t.done === true };
    if (isQuad(t.from)) task.from = t.from;
    if (typeof t.added === 'string' && DATE_RE.test(t.added)) task.added = t.added;
    if (typeof t.finished === 'string' && DATE_RE.test(t.finished)) task.finished = t.finished;
    tasks.push(task);
  }
  return tasks;
}

const sameTask = (a: MatrixTask, b: MatrixTask): boolean => JSON.stringify(a) === JSON.stringify(b);

/** True when this page changed the relative order of tasks it already had. */
function reordered(base: MatrixTask[], local: MatrixTask[]): boolean {
  const inLocal = new Set(local.map((x) => x.id));
  const inBase = new Set(base.map((x) => x.id));
  const before = base.filter((x) => inLocal.has(x.id)).map((x) => x.id);
  const after = local.filter((x) => inBase.has(x.id)).map((x) => x.id);
  return before.some((id, i) => id !== after[i]);
}

/**
 * Lay `tasks` out in this page's order. A task the page never saw (added on
 * another screen) goes right before the next task that was after it on the
 * server, or at the end when nothing placed follows it.
 */
function applyLocalOrder(tasks: MatrixTask[], local: MatrixTask[]): MatrixTask[] {
  const byId = new Map(tasks.map((x) => [x.id, x]));
  const out = local.filter((x) => byId.has(x.id)).map((x) => byId.get(x.id) as MatrixTask);
  const placed = new Set(out.map((x) => x.id));
  for (let i = tasks.length - 1; i >= 0; i--) {
    if (placed.has(tasks[i].id)) continue;
    let at = out.length;
    for (let j = i + 1; j < tasks.length; j++) {
      const k = out.findIndex((o) => o.id === tasks[j].id);
      if (k >= 0) { at = k; break; }
    }
    out.splice(at, 0, tasks[i]);
    placed.add(tasks[i].id);
  }
  return out;
}

/**
 * Three-way merge by task id: start from what the server has now, then apply
 * only what THIS page changed relative to the copy it started from. A task the
 * page never touched keeps whatever the other screen did to it; when both
 * changed the same task, this save wins (it is the most recent intent).
 */
export function mergeMatrix(
  base: MatrixTask[],
  local: MatrixTask[],
  current: MatrixTask[],
  dismissed: { base: string[]; local: string[]; current: string[] } = { base: [], local: [], current: [] },
): { tasks: MatrixTask[]; dismissed: string[] } {
  const baseById = new Map(base.map((x) => [x.id, x]));
  const localIds = new Set(local.map((x) => x.id));

  // Tasks this page deleted: in its base, gone from its list.
  const deletedHere = new Set(base.filter((x) => !localIds.has(x.id)).map((x) => x.id));
  const tasks = current.filter((x) => !deletedHere.has(x.id));
  const index = new Map(tasks.map((x, i) => [x.id, i]));

  for (const mine of local) {
    const before = baseById.get(mine.id);
    if (before && sameTask(before, mine)) continue; // untouched here
    const at = index.get(mine.id);
    if (at === undefined) { index.set(mine.id, tasks.length); tasks.push(mine); }
    else tasks[at] = mine;
  }

  const added = dismissed.local.filter((d) => !dismissed.base.includes(d));
  const merged = [...new Set([...dismissed.current, ...added])].slice(-MAX_DISMISSED);
  const ordered = reordered(base, local) ? applyLocalOrder(tasks, local) : tasks;
  return { tasks: ordered.slice(0, MAX_TASKS), dismissed: merged };
}

function readState(): MatrixState | null {
  if (!fs.existsSync(STATE_FILE)) return null;
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as MatrixState;
}

/** Write via a temp file + rename so a reader never sees a half-written file. */
function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

export function registerBriefRoutes(app: Express, opts: { reviewsDir?: string } = {}): void {
  const log = createLogger('brief');
  const reviewsDir = path.resolve(opts.reviewsDir ?? DEFAULT_REVIEWS_DIR);
  const allowedOrigins = new Set(['null', `http://localhost:${DAEMON_PORT}`, `http://127.0.0.1:${DAEMON_PORT}`]);

  const cors = (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    next();
  };

  // Own parser with a larger cap than the global 16kb one: 200 tasks of text,
  // sent twice (the list plus the base copy it was edited from).
  app.use('/api/brief', cors, express.json({ limit: '256kb' }));

  app.get('/api/brief/matrix', (_req: Request, res: Response) => {
    try {
      res.json(readState() ?? { tasks: [], dismissed: [], updatedAt: null });
    } catch (err) {
      log.error('GET /api/brief/matrix failed', err);
      res.status(500).json({ error: 'Saved matrix could not be read' });
    }
  });

  app.post('/api/brief/matrix', (req: Request, res: Response) => {
    const save = parseMatrix(req.body);
    if (typeof save === 'string') { res.status(400).json({ error: save }); return; }
    try {
      // Desk, the brief and any open tab all write this one file. If another
      // screen saved since this page last read it, merge instead of overwriting.
      const current = readState();
      const changedElsewhere = (current?.updatedAt ?? null) !== save.base.updatedAt;
      const next = changedElsewhere
        ? mergeMatrix(save.base.tasks, save.tasks, current?.tasks ?? [], {
            base: save.base.dismissed, local: save.dismissed, current: current?.dismissed ?? [],
          })
        : { tasks: save.tasks, dismissed: save.dismissed };
      const state: MatrixState = { ...next, updatedAt: new Date().toISOString() };

      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      writeAtomic(STATE_FILE, JSON.stringify(state, null, 2));
      log.info(`matrix saved: ${state.tasks.length} tasks (${state.tasks.filter((t) => t.done).length} done)${changedElsewhere ? ', merged' : ''}`);
      // The full state goes back so the page can show what was merged in.
      res.json({ ok: true, ...state, merged: changedElsewhere });
    } catch (err) {
      log.error('POST /api/brief/matrix failed', err);
      res.status(500).json({ error: 'Could not write the matrix' });
    }
  });

  app.post('/api/brief/review', (req: Request, res: Response) => {
    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const { file, key, decision } = body;
    if (typeof file !== 'string' || !REVIEW_FILE_RE.test(file)) { res.status(400).json({ error: 'file is required (e.g. 2026-07-21.md)' }); return; }
    if (typeof key !== 'string' || !REVIEW_KEY_RE.test(key)) { res.status(400).json({ error: 'key is required' }); return; }
    if (decision !== 'approve' && decision !== 'reject') { res.status(400).json({ error: 'decision must be approve or reject' }); return; }

    const full = path.resolve(reviewsDir, file);
    if (!full.startsWith(reviewsDir + path.sep)) { res.status(400).json({ error: 'file is outside the reviews folder' }); return; }

    try {
      if (!fs.existsSync(full)) { res.status(404).json({ error: 'That review file no longer exists' }); return; }
      const text = fs.readFileSync(full, 'utf8');
      const marker = `<!-- key: ${key} -->`;
      const start = text.indexOf(marker);
      if (start === -1) { res.status(404).json({ error: 'That item is not in the review file' }); return; }
      // The item's section runs to the next "### " heading (or end of file).
      const nextHeading = text.indexOf('\n### ', start);
      const end = nextHeading === -1 ? text.length : nextHeading;
      const section = text.slice(start, end);
      if (/^\s*- \[x\]/im.test(section)) { res.status(409).json({ error: 'This item was already decided' }); return; }

      const label = decision === 'approve' ? 'Approve' : 'Reject';
      const box = new RegExp(`^(\\s*- )\\[ \\](\\s*${label})\\s*$`, 'm');
      if (!box.test(section)) { res.status(422).json({ error: `No unticked "${label}" box in that item` }); return; }
      writeAtomic(full, text.slice(0, start) + section.replace(box, '$1[x]$2') + text.slice(end));
      log.info(`review decision recorded: ${decision} (${file})`);
      res.json({ ok: true, decision });
    } catch (err) {
      log.error('POST /api/brief/review failed', err);
      res.status(500).json({ error: 'Could not update the review file' });
    }
  });
}
