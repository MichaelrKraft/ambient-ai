/**
 * NotebookLMClient — Thin wrapper around the `notebooklm` npm CLI.
 *
 * Shells out to the `notebooklm` command-line tool for all operations.
 * This avoids reverse-engineering the API and lets the CLI handle auth,
 * rate limits, and API changes.
 *
 * CLI reference (notebooklm@0.1.1):
 *   notebooklm login                          — Authenticate with Google
 *   notebooklm notebook create <title>         — Create notebook
 *   notebooklm notebook info <notebookId>      — Get notebook details
 *   notebooklm notebook list                   — List all notebooks
 *   notebooklm source add-file <id> <path>     — Upload file as source
 *   notebooklm generate audio <id>             — Generate podcast
 *   notebooklm generate report <id>            — Generate report
 *   notebooklm generate flashcards <id>        — Generate flashcards
 */

import { execSync, execFileSync } from 'child_process';
import { createLogger } from '../shared/logger.js';

const log = createLogger('notebooklm');

export type DeliverableType = 'audio' | 'report' | 'flashcards' | 'video' | 'quiz';

export interface NotebookInfo {
  id: string;
  name: string;
  sourceCount: number;
}

export class NotebookLMClient {
  private cliPath: string | null = null;

  /**
   * Check if the notebooklm CLI is installed and accessible.
   */
  isInstalled(): boolean {
    try {
      const result = execSync('which notebooklm 2>/dev/null', { encoding: 'utf8' }).trim();
      if (result) {
        this.cliPath = result;
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Check if the user is authenticated with NotebookLM.
   * Tries listing notebooks — if it fails, auth is missing.
   */
  isAuthenticated(): boolean {
    if (!this.isInstalled()) return false;

    try {
      this.exec(['notebook', 'list']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a new notebook with the given title.
   * Returns the notebook ID.
   */
  createNotebook(title: string): string {
    const result = this.exec(['notebook', 'create', title]);
    log.info(`Created notebook: ${title}`);

    // Parse notebook ID from output
    // CLI output format: "✓ Created notebook: title\nID: b2345179-321c-4463-b5b3-bd7d7f089403"
    const idMatch = result.match(/ID:\s*([a-f0-9-]{36})/i)
      ?? result.match(/ID:\s*([a-zA-Z0-9_-]{10,})/i)
      ?? result.match(/([a-f0-9-]{36})/);
    if (!idMatch) {
      throw new Error(`Could not parse notebook ID from output: ${result}`);
    }

    return idMatch[1];
  }

  /**
   * Add a local file as a source to a notebook.
   * Uses `add-text --file` instead of `add-file` because the upload
   * endpoint returns HTTP 400. Text paste works reliably.
   */
  addSource(notebookId: string, filePath: string): void {
    const fileName = filePath.split('/').pop() ?? 'source';
    const title = fileName.replace(/\.md$/, '');
    this.exec(['source', 'add-text', notebookId, title, '--file', filePath]);
    log.info(`Added source to ${notebookId}: ${filePath}`);
  }

  /**
   * Add multiple files as sources to a notebook.
   */
  addSources(notebookId: string, filePaths: string[]): void {
    for (const filePath of filePaths) {
      this.addSource(notebookId, filePath);
    }
  }

  /**
   * Generate a deliverable from a notebook.
   * Returns the raw CLI output (may contain file path or status info).
   */
  generateDeliverable(notebookId: string, type: DeliverableType): string {
    log.info(`Generating ${type} from notebook ${notebookId}...`);
    const result = this.exec(['generate', type, notebookId], 600000); // 10min timeout

    // Try to extract output file path from CLI output
    const pathMatch = result.match(/(?:saved|output|file|download)[:\s]+(.+\.\w+)/i);
    if (pathMatch) {
      return pathMatch[1].trim();
    }

    return result.trim();
  }

  /**
   * Get info about a notebook.
   */
  getNotebookInfo(notebookId: string): NotebookInfo | null {
    try {
      const result = this.exec(['notebook', 'info', notebookId]);
      return {
        id: notebookId,
        name: result.match(/(?:title|name)[:\s]+(.+)/i)?.[1]?.trim() ?? notebookId,
        sourceCount: parseInt(result.match(/sources?[:\s]+(\d+)/i)?.[1] ?? '0', 10),
      };
    } catch {
      return null;
    }
  }

  /**
   * List all notebooks.
   */
  listNotebooks(): string {
    return this.exec(['notebook', 'list']);
  }

  /**
   * Execute a notebooklm CLI command.
   */
  private exec(args: string[], timeoutMs: number = 120000): string {
    if (!this.cliPath && !this.isInstalled()) {
      throw new Error(
        'notebooklm CLI not found. Install with: npm install -g notebooklm'
      );
    }

    try {
      return execFileSync(this.cliPath ?? 'notebooklm', args, {
        encoding: 'utf8',
        timeout: timeoutMs,
        env: process.env,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`notebooklm CLI error: ${msg}`);
      throw new Error(`NotebookLM CLI failed: ${msg}`);
    }
  }
}
