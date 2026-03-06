/**
 * NotebookLMSync — Orchestrate syncing Ambient data to NotebookLM.
 *
 * Manages persistent notebooks per time period (daily, weekly) and
 * handles source uploading and deliverable generation.
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '../shared/logger.js';
import { NotebookLMClient } from './NotebookLMClient.js';
import type { DeliverableType } from './NotebookLMClient.js';
// DeliverableType = 'audio' | 'report' | 'flashcards' | 'video' | 'quiz'

const log = createLogger('notebooklm-sync');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NotebookMapping {
  [periodKey: string]: string; // e.g., "2026-03-05" → "notebook-id-123"
}

export interface SyncResult {
  success: boolean;
  notebookId?: string;
  sourcesAdded: number;
  error?: string;
}

export interface DeliverableResult {
  success: boolean;
  output?: string;
  type?: DeliverableType;
  error?: string;
}

// ---------------------------------------------------------------------------
// Sync orchestrator
// ---------------------------------------------------------------------------

export class NotebookLMSync {
  private client: NotebookLMClient;
  private mappingPath: string;
  private mappings: NotebookMapping;
  private prefix: string;

  constructor(dataDir: string, prefix: string = 'ambient') {
    this.client = new NotebookLMClient();
    this.mappingPath = path.join(dataDir, 'notebooklm-mappings.json');
    this.prefix = prefix;
    this.mappings = this.loadMappings();
  }

  /**
   * Check if NotebookLM integration is available.
   */
  isAvailable(): { installed: boolean; authenticated: boolean } {
    const installed = this.client.isInstalled();
    const authenticated = installed ? this.client.isAuthenticated() : false;
    return { installed, authenticated };
  }

  /**
   * Sync today's daily note to NotebookLM.
   */
  syncToday(vaultPath: string): SyncResult {
    const today = new Date();
    const dateStr = formatDate(today);
    const dailyNotePath = path.join(vaultPath, 'Daily', `${dateStr}.md`);

    if (!fs.existsSync(dailyNotePath)) {
      return { success: false, sourcesAdded: 0, error: `Daily note not found: ${dailyNotePath}` };
    }

    return this.syncFiles(`daily-${dateStr}`, [dailyNotePath]);
  }

  /**
   * Sync the last 7 daily notes to a weekly NotebookLM notebook.
   */
  syncWeek(vaultPath: string): SyncResult {
    const files: string[] = [];
    const now = new Date();

    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const dateStr = formatDate(d);
      const filePath = path.join(vaultPath, 'Daily', `${dateStr}.md`);
      if (fs.existsSync(filePath)) {
        files.push(filePath);
      }
    }

    if (files.length === 0) {
      return { success: false, sourcesAdded: 0, error: 'No daily notes found for the past 7 days' };
    }

    // Also include the weekly summary if it exists
    const weeklyDir = path.join(vaultPath, 'Weekly');
    if (fs.existsSync(weeklyDir)) {
      const weeklyFiles = fs.readdirSync(weeklyDir)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .slice(-1); // Latest weekly summary
      for (const f of weeklyFiles) {
        files.push(path.join(weeklyDir, f));
      }
    }

    const weekKey = getISOWeek(now);
    return this.syncFiles(`weekly-${weekKey}`, files);
  }

  /**
   * Generate a deliverable from a period's notebook.
   */
  generateDeliverable(periodKey: string, type: DeliverableType): DeliverableResult {
    const fullKey = `${this.prefix}-${periodKey}`;
    const notebookId = this.mappings[fullKey];

    if (!notebookId) {
      return { success: false, error: `No notebook found for period: ${periodKey}. Run sync first.` };
    }

    try {
      const output = this.client.generateDeliverable(notebookId, type);
      log.info(`Generated ${type} for ${periodKey}: ${output}`);
      return { success: true, output, type };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  /**
   * Get status of notebooks managed by this sync instance.
   */
  getStatus(): { notebooks: Array<{ period: string; notebookId: string }> } {
    const notebooks = Object.entries(this.mappings).map(([period, notebookId]) => ({
      period,
      notebookId,
    }));
    return { notebooks };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private syncFiles(periodKey: string, files: string[]): SyncResult {
    const fullKey = `${this.prefix}-${periodKey}`;

    try {
      // Get or create notebook
      let notebookId = this.mappings[fullKey];
      if (!notebookId) {
        notebookId = this.client.createNotebook(fullKey);
        this.mappings[fullKey] = notebookId;
        this.saveMappings();
        log.info(`Created notebook ${fullKey} → ${notebookId}`);
      }

      // Add sources
      this.client.addSources(notebookId, files);
      log.info(`Synced ${files.length} files to ${fullKey}`);

      return { success: true, notebookId, sourcesAdded: files.length };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Sync failed for ${fullKey}: ${msg}`);
      return { success: false, sourcesAdded: 0, error: msg };
    }
  }

  private loadMappings(): NotebookMapping {
    try {
      if (fs.existsSync(this.mappingPath)) {
        return JSON.parse(fs.readFileSync(this.mappingPath, 'utf8'));
      }
    } catch {
      log.warn('Could not load notebook mappings, starting fresh');
    }
    return {};
  }

  private saveMappings(): void {
    const dir = path.dirname(this.mappingPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.mappingPath, JSON.stringify(this.mappings, null, 2));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(date: Date): string {
  const yyyy = date.getFullYear().toString();
  const mm = (date.getMonth() + 1).toString().padStart(2, '0');
  const dd = date.getDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function getISOWeek(date: Date): string {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const weekNum = 1 + Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}
