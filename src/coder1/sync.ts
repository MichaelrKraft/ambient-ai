import { AmbientConfig } from '../config/index.js';

const SYNC_TIMEOUT_MS = 10_000;

/**
 * Sync a daily Ambient note to Coder1's Notes panel.
 *
 * This is best-effort — failures are logged as warnings and never
 * propagate to the caller or break the Obsidian export flow.
 */
export async function syncToCoder1(
  date: string,
  markdownContent: string,
  config: AmbientConfig
): Promise<void> {
  if (!config.coder1Token) return;

  const baseUrl = (config.coder1BaseUrl ?? 'https://coder1.ai').replace(/\/$/, '');
  const notePath = `Ambient/${date}.md`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/api/notes`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.coder1Token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        path: notePath,
        title: `Ambient: ${date}`,
        content: markdownContent,
        frontmatter: {
          source: 'ambient-ai',
          date,
          synced_at: new Date().toISOString(),
        },
      }),
      signal: controller.signal,
    });

    if (response.status === 401) {
      console.warn(
        '[Ambient → Coder1] Token is invalid or expired. ' +
        'Get a new token at coder1.ai/settings → Integrations → Ambient AI.'
      );
      return;
    }

    if (!response.ok) {
      console.warn(
        `[Ambient → Coder1] Sync failed (HTTP ${response.status}). ` +
        'Notes were saved to Obsidian. Coder1 sync skipped this cycle.'
      );
      return;
    }

    const action = response.status === 201 ? 'Created' : 'Updated';
    console.log(`[Ambient → Coder1] ${action} note: ${notePath}`);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.warn('[Ambient → Coder1] Sync timed out after 10s. Skipping this cycle.');
    } else {
      console.warn(
        '[Ambient → Coder1] Could not reach Coder1. ' +
        'Notes were saved to Obsidian only.',
        err instanceof Error ? err.message : err
      );
    }
  } finally {
    clearTimeout(timer);
  }
}
