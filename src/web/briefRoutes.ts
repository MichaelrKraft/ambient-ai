/**
 * briefRoutes — write endpoints for the morning brief page.
 *
 * The brief is a static HTML file, usually opened as file://, so it cannot
 * write to disk itself. Until 2026-09-18 that meant the Eisenhower matrix lived
 * only in Chrome's localStorage and improve-system sign-offs could not be ticked
 * from the page. These routes give the page somewhere to save:
 *
 *   GET  /api/brief/matrix   → last saved matrix state (or { tasks: [] })
 *   POST /api/brief/matrix   → persist state + rewrite ~/Desktop/TODAY.md
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
const TODAY_FILE = path.join(os.homedir(), 'Desktop', 'TODAY.md');
const DEFAULT_REVIEWS_DIR = path.join(os.homedir(), 'Documents', 'Obsidian Notes', 'Output', 'reviews');

function isQuad(v: unknown): v is Quad {
  return typeof v === 'string' && (QUADS as readonly string[]).includes(v);
}

/** Returns a clean state, or a string describing the first problem found. */
function parseMatrix(body: unknown): MatrixState | string {
  if (typeof body !== 'object' || body === null) return 'body must be a JSON object';
  const raw = body as Record<string, unknown>;
  if (!Array.isArray(raw.tasks)) return 'tasks is required and must be an array';
  if (raw.tasks.length > MAX_TASKS) return `tasks is limited to ${MAX_TASKS} items`;

  const tasks: MatrixTask[] = [];
  for (const item of raw.tasks) {
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

  const dismissed = Array.isArray(raw.dismissed)
    ? raw.dismissed
        .filter((d): d is string => typeof d === 'string' && d.length <= MAX_TEXT)
        .slice(-MAX_DISMISSED)
    : [];
  return { tasks, dismissed, updatedAt: new Date().toISOString() };
}

/** The glanceable Desktop file. Plain markdown so Quick Look (space bar) renders it. */
function renderToday(state: MatrixState): string {
  const heading = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Denver',
  });
  const section = (title: string, hint: string, quad: Quad): string => {
    const rows = state.tasks.filter((t) => t.quad === quad);
    const lines = rows.length
      ? rows.map((t) => `- [${t.done ? 'x' : ' '}] ${t.text.replace(/\s+/g, ' ')}`)
      : ['- (nothing here)'];
    return `## ${title}\n_${hint}_\n\n${lines.join('\n')}\n`;
  };
  return [
    `# Today — ${heading}`,
    '',
    section('Do', 'Important and urgent. Before email.', 'do'),
    section('Schedule', 'Important, not urgent. Give it a calendar block.', 'schedule'),
    section('Delegate', 'Urgent, not important. Hand it to an agent.', 'delegate'),
    section('Done', 'Finished.', 'done'),
    `_Written by the morning brief's matrix at ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver' })}. Edit tasks in the brief, not here — this file is overwritten on every change._`,
    '',
  ].join('\n');
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

  // Own parser with a larger cap than the global 16kb one: 200 tasks of text.
  app.use('/api/brief', cors, express.json({ limit: '128kb' }));

  app.get('/api/brief/matrix', (_req: Request, res: Response) => {
    try {
      if (!fs.existsSync(STATE_FILE)) { res.json({ tasks: [], dismissed: [], updatedAt: null }); return; }
      res.json(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
    } catch (err) {
      log.error('GET /api/brief/matrix failed', err);
      res.status(500).json({ error: 'Saved matrix could not be read' });
    }
  });

  app.post('/api/brief/matrix', (req: Request, res: Response) => {
    const state = parseMatrix(req.body);
    if (typeof state === 'string') { res.status(400).json({ error: state }); return; }
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      writeAtomic(STATE_FILE, JSON.stringify(state, null, 2));
      writeAtomic(TODAY_FILE, renderToday(state));
      log.info(`matrix saved: ${state.tasks.length} tasks (${state.tasks.filter((t) => t.done).length} done)`);
      res.json({ ok: true, updatedAt: state.updatedAt, todayFile: '~/Desktop/TODAY.md' });
    } catch (err) {
      log.error('POST /api/brief/matrix failed', err);
      res.status(500).json({ error: 'Could not write the matrix or TODAY.md' });
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
