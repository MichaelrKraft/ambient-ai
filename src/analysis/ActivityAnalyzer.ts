/**
 * ActivityAnalyzer — sends deduplicated OCR batches to Claude Haiku and
 * persists the structured results to SQLite via AmbientStore.
 *
 * Cost guardrail: aborts if the daily token budget (50k) is already exhausted.
 * PII filter: all knowledge and error text is sanitised before storage.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../shared/logger.js';
import { withRetry } from '../shared/retry.js';
import { nowISO } from '../shared/time.js';
import { getDb } from '../storage/db.js';
import * as store from '../storage/AmbientStore.js';
import { filterPII, isPIISuspicious } from './PIIFilter.js';
import type { AnalysisBatch, AnalysisResult } from './types.js';
import type { OcrEntry } from '../screenpipe/types.js';

// ── Constants ──────────────────────────────────────────────────────────────

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 1024;
const DAILY_TOKEN_BUDGET = 50_000;

/**
 * Maximum characters kept per app's text block in the prompt.
 * Keeps total prompt well under 6 000 tokens even with many apps.
 */
const MAX_CHARS_PER_APP = 500;

/** Max number of OCR entries to keep per app after deduplication. */
const MAX_ENTRIES_PER_APP = 3;

// ── Minimal fallback result ────────────────────────────────────────────────

function buildFallback(entries: OcrEntry[]): AnalysisResult {
  const uniqueApps = [...new Set(entries.map((e) => e.appName))];
  return {
    activity: {
      summary: 'Analysis unavailable',
      category: 'other',
      primaryApp: entries[0]?.appName ?? 'unknown',
      appsPresent: uniqueApps,
    },
    knowledge: [],
    errors: [],
    goalProgress: [],
    tokenCost: 0,
  };
}

// ── Claude response shape (validated at runtime) ───────────────────────────

interface ClaudeActivityPayload {
  summary: string;
  category: string;
  primaryApp: string;
  appsPresent: string[];
}

interface ClaudeKnowledgeItem {
  content: string;
  category: string;
}

interface ClaudeErrorItem {
  text: string;
  appName: string;
}

interface ClaudeGoalProgressItem {
  goalId: string;
  evidence: string;
  confidence: number;
}

interface ClaudeResponse {
  activity: ClaudeActivityPayload;
  knowledge: ClaudeKnowledgeItem[];
  errors: ClaudeErrorItem[];
  goalProgress: ClaudeGoalProgressItem[];
}

// ── Type guards ────────────────────────────────────────────────────────────

function isValidCategory(
  v: string,
): v is 'coding' | 'browsing' | 'meeting' | 'design' | 'writing' | 'other' {
  return ['coding', 'browsing', 'meeting', 'design', 'writing', 'other'].includes(v);
}

function isValidKnowledgeCategory(
  v: string,
): v is 'decision' | 'learning' | 'bug-fix' | 'pattern' {
  return ['decision', 'learning', 'bug-fix', 'pattern'].includes(v);
}

// ── Deduplication ──────────────────────────────────────────────────────────

/**
 * Groups entries by appName, sorts each group by timestamp ascending,
 * and keeps only the last MAX_ENTRIES_PER_APP entries per app.
 * Returns a map of appName → entries (the most-recent context for each app).
 */
function deduplicateEntries(entries: OcrEntry[]): Map<string, OcrEntry[]> {
  const byApp = new Map<string, OcrEntry[]>();

  for (const entry of entries) {
    const group = byApp.get(entry.appName) ?? [];
    group.push(entry);
    byApp.set(entry.appName, group);
  }

  for (const [app, group] of byApp.entries()) {
    group.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    byApp.set(app, group.slice(-MAX_ENTRIES_PER_APP));
  }

  return byApp;
}

// ── Prompt builder ─────────────────────────────────────────────────────────

function buildPrompt(batch: AnalysisBatch): string {
  const { periodStart, periodEnd, goals } = batch;
  const byApp = deduplicateEntries(batch.entries);

  const screenContent = [...byApp.entries()]
    .map(([app, entries]) => {
      const combined = entries
        .map((e) => `[${e.windowName}]\n${e.text}`)
        .join('\n')
        .slice(0, MAX_CHARS_PER_APP);
      return `[${app}]\n${combined}\n---`;
    })
    .join('\n\n');

  const goalsText =
    goals.length > 0
      ? goals
          .map(
            (g) =>
              `- [${g.id}] ${g.title}${g.description ? ': ' + g.description : ''}`,
          )
          .join('\n')
      : 'None set';

  return `You are analyzing a developer's screen activity. Extract structured insights.

ACTIVITY PERIOD: ${periodStart} to ${periodEnd}

SCREEN CONTENT (OCR text, grouped by app):
${screenContent}

ACTIVE GOALS:
${goalsText}

Respond with ONLY valid JSON matching this schema:
{
  "activity": {
    "summary": "1-2 sentences describing what the developer was working on",
    "category": "coding|browsing|meeting|design|writing|other",
    "primaryApp": "most prominent app name",
    "appsPresent": ["array", "of", "all", "app", "names"]
  },
  "knowledge": [
    {"content": "specific insight, decision, or learning (skip obvious things)", "category": "decision|learning|bug-fix|pattern"}
  ],
  "errors": [
    {"text": "concise error description — not the full stack trace", "appName": "app where error appeared"}
  ],
  "goalProgress": [
    {"goalId": "goal id from the list above", "evidence": "specific activity that suggests progress", "confidence": 0.7}
  ]
}

GUIDELINES:
- knowledge: only include genuinely useful items (decisions made, bugs fixed, patterns discovered). Max 3 items.
- errors: only include actual errors (TypeErrors, build failures, 404s, etc.), not warnings or lint suggestions. Max 3 items.
- goalProgress: only include if there is clear evidence. confidence=0.0 if unsure, skip the item entirely.
- summary: be specific. "Debugging a React useState hook issue in the checkout flow" is better than "coding".`;
}

// ── Main class ─────────────────────────────────────────────────────────────

export class ActivityAnalyzer {
  private readonly client: Anthropic;
  private readonly log: ReturnType<typeof createLogger>;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
    this.log = createLogger('analyzer');
  }

  async analyze(batch: AnalysisBatch): Promise<AnalysisResult> {
    const { entries, periodStart, periodEnd, goals } = batch;

    // Guard: empty batch — return fallback immediately, no API call.
    if (entries.length === 0) {
      this.log.warn('analyze called with empty batch — returning fallback');
      return buildFallback(entries);
    }

    // Initialise the store (opens DB singleton if not already open).
    void getDb();

    // Guard: daily token budget.
    const dailyTokens = store.getDailyTokenCount();
    if (dailyTokens > DAILY_TOKEN_BUDGET) {
      this.log.warn(
        `Daily token budget exceeded (50k). Skipping analysis until tomorrow.`,
        { dailyTokens },
      );
      return buildFallback(entries);
    }

    this.log.info('Analyzing batch', {
      entries: entries.length,
      period: `${periodStart} → ${periodEnd}`,
    });

    const prompt = buildPrompt(batch);

    let rawResponse: string;
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const message = await withRetry(
        () =>
          this.client.messages.create({
            model: MODEL,
            max_tokens: MAX_TOKENS,
            temperature: 0,
            messages: [{ role: 'user', content: prompt }],
          }),
        { maxAttempts: 3, baseDelayMs: 5_000 },
      );

      inputTokens = message.usage.input_tokens;
      outputTokens = message.usage.output_tokens;

      const firstBlock = message.content[0];
      rawResponse =
        firstBlock?.type === 'text' ? firstBlock.text : '';
    } catch (err) {
      this.log.error('Anthropic API error — returning fallback', err);
      return buildFallback(entries);
    }

    // Parse JSON response — strip markdown code blocks if present (```json ... ```)
    let parsed: ClaudeResponse;
    try {
      let jsonStr = rawResponse.trim();
      // Strip markdown code block wrapper if present
      if (jsonStr.startsWith('```')) {
        // Remove opening fence (e.g., ```json or just ```)
        jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, '');
        // Remove closing fence
        jsonStr = jsonStr.replace(/\n?```\s*$/, '');
      }
      parsed = JSON.parse(jsonStr) as ClaudeResponse;
    } catch (err) {
      this.log.error('JSON parse failed — returning fallback', err);
      this.log.warn('Raw Claude response', { rawResponse });
      return buildFallback(entries);
    }

    const tokenCost = inputTokens + outputTokens;

    // Normalise activity category with fallback to 'other'.
    const rawCategory = parsed.activity?.category ?? 'other';
    const category = isValidCategory(rawCategory) ? rawCategory : 'other';

    // Build the typed result, applying PII filtering to all text fields.
    const result: AnalysisResult = {
      activity: {
        summary: filterPII(parsed.activity?.summary ?? 'No summary available'),
        category,
        primaryApp: parsed.activity?.primaryApp ?? (entries[0]?.appName ?? 'unknown'),
        appsPresent: Array.isArray(parsed.activity?.appsPresent)
          ? parsed.activity.appsPresent
          : [...new Set(entries.map((e) => e.appName))],
      },
      knowledge: (Array.isArray(parsed.knowledge) ? parsed.knowledge : [])
        .slice(0, 3)
        .map((k) => ({
          content: filterPII(k.content ?? ''),
          category: isValidKnowledgeCategory(k.category) ? k.category : 'learning',
        }))
        .filter((k) => k.content.length > 0),
      errors: (Array.isArray(parsed.errors) ? parsed.errors : [])
        .slice(0, 3)
        .map((e) => ({
          text: filterPII(e.text ?? ''),
          appName: e.appName ?? 'unknown',
        }))
        .filter((e) => e.text.length > 0),
      goalProgress: (Array.isArray(parsed.goalProgress) ? parsed.goalProgress : [])
        .filter(
          (gp) =>
            typeof gp.goalId === 'string' &&
            gp.goalId.length > 0 &&
            typeof gp.confidence === 'number' &&
            gp.confidence > 0,
        )
        .map((gp) => ({
          goalId: gp.goalId,
          evidence: filterPII(gp.evidence ?? ''),
          confidence: Math.min(1, Math.max(0, gp.confidence)),
        })),
      tokenCost,
    };

    this.log.info('Analysis complete', {
      category: result.activity.category,
      summary: result.activity.summary,
      tokens: tokenCost,
    });

    // ── Persist results ───────────────────────────────────────────────────

    store.addDailyTokenCount(tokenCost);

    store.insertActivitySession({
      period_start: periodStart,
      period_end: periodEnd,
      primary_app: result.activity.primaryApp,
      summary: result.activity.summary,
      category: result.activity.category,
      apps_seen: result.activity.appsPresent,
      token_cost: tokenCost,
    });

    for (const knowledge of result.knowledge) {
      store.insertKnowledgeItem({
        content: knowledge.content,
        category: knowledge.category,
        source_apps: result.activity.appsPresent,
        extracted_at: nowISO(),
        is_pii_flagged: isPIISuspicious(knowledge.content),
      });
    }

    for (const error of result.errors) {
      store.upsertErrorEvent(error.text, error.appName);
    }

    for (const gp of result.goalProgress) {
      store.insertGoalProgress({
        goal_id: gp.goalId,
        timestamp: nowISO(),
        evidence: gp.evidence,
        confidence: gp.confidence,
      });
    }

    return result;
  }
}
