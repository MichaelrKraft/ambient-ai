/**
 * Web dashboard server for ambient.
 *
 * Serves static files from src/web/public/ and exposes a JSON API
 * that the frontend uses to query the ambient store.
 *
 * This module is called from the daemon — it is not a standalone entry point.
 * The `store` parameter is accepted for forward-compatibility with the daemon
 * call-site interface; API handlers call the store module functions directly
 * since the store is function-based, not class-based.
 */

import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import type { Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import {
  getRecentActivity,
  searchKnowledge,
  getRecentKnowledge,
  getUnresolvedErrors,
  getActiveGoals,
  getOpenTasks,
  getOverdueTasks,
  getUpcomingTasks,
  markTaskDone,
  getDailyTokenCount,
  addDailyTokenCount,
  getDaemonState,
} from '../storage/AmbientStore.js';
import { loadConfig } from '../config/index.js';
import { DAEMON_PORT } from '../config/paths.js';
import { createLogger } from '../shared/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mirrors ActivityAnalyzer's daily cap so the /ask route can never blow the
// shared budget. The whole daemon counts tokens into one daily counter.
const DAILY_TOKEN_BUDGET = 50_000;
const ASK_MODEL = 'claude-haiku-4-5-20251001';
const ASK_MAX_TOKENS = 600;

/**
 * Creates and starts the Express HTTP server for the web dashboard.
 * The `store` parameter is kept for interface compatibility with daemon callers;
 * internally the module-level store functions are used directly.
 */
export function createWebServer(_store: Record<string, unknown>): http.Server {
  const app = express();
  const log = createLogger('web');

  // ------------------------------------------------------------------
  // Static files — index.html, styles.css, app.js
  // ------------------------------------------------------------------

  app.use(express.static(path.join(__dirname, 'public')));

  // Body parser for POST /ask. Small limit — questions are short.
  app.use(express.json({ limit: '16kb' }));

  // ------------------------------------------------------------------
  // JSON API endpoints
  // ------------------------------------------------------------------

  app.get('/api/tasks', (req: Request, res: Response) => {
    const filter = req.query['filter'];
    try {
      const tasks =
        filter === 'overdue'
          ? getOverdueTasks()
          : filter === 'upcoming'
            ? getUpcomingTasks(48)
            : getOpenTasks();
      res.json(tasks);
    } catch (err) {
      log.error('GET /api/tasks failed', err);
      res.status(500).json({ error: 'Failed to fetch tasks' });
    }
  });

  app.post('/api/tasks/:id/done', (req: Request, res: Response) => {
    const rawId = req.params['id'];
    const id = parseInt(typeof rawId === 'string' ? rawId : '', 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'invalid task id' });
      return;
    }
    try {
      const ok = markTaskDone(id);
      res.json({ ok });
    } catch (err) {
      log.error('POST /api/tasks/:id/done failed', err);
      res.status(500).json({ error: 'Failed to complete task' });
    }
  });

  app.get('/api/activity', (req: Request, res: Response) => {
    const hoursBack = parseIntParam(req.query['hours'], 24);
    try {
      const sessions = getRecentActivity(hoursBack, 50);
      res.json(sessions);
    } catch (err) {
      log.error('GET /api/activity failed', err);
      res.status(500).json({ error: 'Failed to fetch activity' });
    }
  });

  app.get('/api/knowledge', (req: Request, res: Response) => {
    const query = typeof req.query['q'] === 'string' ? req.query['q'] : '';
    const limit = parseIntParam(req.query['limit'], 20);
    try {
      const items = query
        ? searchKnowledge(query, limit)
        : getRecentKnowledge(48, limit);
      res.json(items);
    } catch (err) {
      log.error('GET /api/knowledge failed', err);
      res.status(500).json({ error: 'Failed to fetch knowledge' });
    }
  });

  app.get('/api/errors', (_req: Request, res: Response) => {
    try {
      // olderThanMinutes=0 returns all unresolved errors regardless of age.
      const errors = getUnresolvedErrors(0);
      res.json(errors);
    } catch (err) {
      log.error('GET /api/errors failed', err);
      res.status(500).json({ error: 'Failed to fetch errors' });
    }
  });

  app.get('/api/goals', (_req: Request, res: Response) => {
    try {
      const goals = getActiveGoals();
      res.json(goals);
    } catch (err) {
      log.error('GET /api/goals failed', err);
      res.status(500).json({ error: 'Failed to fetch goals' });
    }
  });

  app.get('/api/status', (_req: Request, res: Response) => {
    try {
      const dailyTokens = getDailyTokenCount();
      const lastPoll = getDaemonState('last_poll_time');
      res.json({
        running: true,
        dailyTokens,
        lastPoll,
        tokenBudget: 50000,
      });
    } catch (err) {
      log.error('GET /api/status failed', err);
      res.status(500).json({ error: 'Failed to fetch status' });
    }
  });

  // ------------------------------------------------------------------
  // POST /ask — conversational memory Q&A over the ambient store.
  //
  // Runs one Haiku synthesis call grounded in FTS knowledge + recent activity
  // + open tasks. Honors the SHARED daily token budget (the same counter the
  // analyzer uses) so it can never overspend, and refuses when the budget is
  // exhausted. The server binds to 127.0.0.1 only (see app.listen below).
  // ------------------------------------------------------------------

  app.post('/ask', (req: Request, res: Response) => {
    void handleAsk(req, res, log);
  });

  // ------------------------------------------------------------------
  // Start listening — bind to loopback only (single-user local dashboard
  // that can now spend Anthropic tokens via /ask).
  // ------------------------------------------------------------------

  const server = app.listen(DAEMON_PORT, '127.0.0.1', () => {
    log.info(`Dashboard available at http://localhost:${DAEMON_PORT}`);
  });

  return server;
}

/**
 * Handles POST /ask. Separated out so the route stays a thin shim.
 * Body: { question: string }. Returns { answer: string }.
 */
async function handleAsk(
  req: Request,
  res: Response,
  log: ReturnType<typeof createLogger>,
): Promise<void> {
  const question =
    typeof req.body?.question === 'string' ? req.body.question.trim() : '';
  if (!question) {
    res.status(400).json({ error: 'question is required' });
    return;
  }

  // Shared budget guard — refuse if today's tokens are already spent.
  try {
    if (getDailyTokenCount() > DAILY_TOKEN_BUDGET) {
      res.status(429).json({
        error: 'Daily token budget reached — try again tomorrow.',
      });
      return;
    }
  } catch (err) {
    log.error('POST /ask budget check failed', err);
    res.status(500).json({ error: 'Internal error' });
    return;
  }

  let apiKey: string;
  try {
    apiKey = loadConfig().anthropicApiKey;
  } catch {
    res.status(503).json({ error: 'Ambient is not configured (no API key).' });
    return;
  }

  // Gather grounding context. Keep each block small to bound prompt tokens.
  let context: string;
  try {
    const knowledge = searchKnowledge(question, 8);
    const activity = getRecentActivity(48, 8);
    const tasks = getOpenTasks(20);

    const kBlock = knowledge.length
      ? knowledge.map((k) => `- [${k.category ?? 'note'} @ ${k.extracted_at}] ${k.content}`).join('\n')
      : '(none)';
    const aBlock = activity.length
      ? activity.map((a) => `- ${a.period_start} [${a.primary_app ?? '?'}] ${a.summary ?? ''}`).join('\n')
      : '(none)';
    const tBlock = tasks.length
      ? tasks.map((t) => `- ${t.content}${t.due_date ? ` (due ${t.due_date})` : ''}`).join('\n')
      : '(none)';

    context = `KNOWLEDGE (decisions/learnings/patterns):\n${kBlock}\n\nRECENT ACTIVITY:\n${aBlock}\n\nOPEN TASKS:\n${tBlock}`;
  } catch (err) {
    log.error('POST /ask context build failed', err);
    res.status(500).json({ error: 'Failed to read ambient memory' });
    return;
  }

  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: ASK_MODEL,
      max_tokens: ASK_MAX_TOKENS,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content:
            `You are Ambient, answering the user's question about their own past work using ONLY the context below. ` +
            `Lead with a direct 1-2 sentence answer; cite when things happened. If the context doesn't contain the answer, say so plainly.\n\n` +
            `QUESTION: ${question}\n\n${context}`,
        },
      ],
    });

    // Track spend against the shared daily counter.
    const used = message.usage.input_tokens + message.usage.output_tokens;
    try {
      addDailyTokenCount(used);
    } catch (err) {
      log.warn('POST /ask token tracking failed (non-fatal)', { error: String(err) });
    }

    const first = message.content[0];
    const answer = first?.type === 'text' ? first.text : '(no answer)';
    res.json({ answer });
  } catch (err) {
    log.error('POST /ask Anthropic call failed', err);
    res.status(502).json({ error: 'Failed to generate an answer' });
  }
}

// ------------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------------

/**
 * Safely parses a query-string value as a positive integer.
 * Falls back to `defaultValue` when the value is absent or not a valid number.
 */
function parseIntParam(value: unknown, defaultValue: number): number {
  if (typeof value !== 'string') return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) || parsed < 1 ? defaultValue : parsed;
}
