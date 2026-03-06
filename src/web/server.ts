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
import {
  getRecentActivity,
  searchKnowledge,
  getRecentKnowledge,
  getUnresolvedErrors,
  getActiveGoals,
  getDailyTokenCount,
  getDaemonState,
} from '../storage/AmbientStore.js';
import { DAEMON_PORT } from '../config/paths.js';
import { createLogger } from '../shared/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

  // ------------------------------------------------------------------
  // JSON API endpoints
  // ------------------------------------------------------------------

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
  // Start listening
  // ------------------------------------------------------------------

  const server = app.listen(DAEMON_PORT, () => {
    log.info(`Dashboard available at http://localhost:${DAEMON_PORT}`);
  });

  return server;
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
