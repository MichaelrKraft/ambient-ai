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
// Raised from 1024 → 1280 to make room for the tasks array (capped at 2 items)
// without risking truncated JSON, which would fail JSON.parse and drop the
// entire cycle's activity/knowledge/errors to the fallback path.
const MAX_TOKENS = 1280;
// Raised from 50k → 200k on 2026-08-07: at a 7-min poll cadence, 50k only
// covered ~4.5 hours before going silent for the rest of the day. 200k
// covers a 7am-midnight window (~146 cycles) at roughly $1-1.50/day on Haiku.
const DAILY_TOKEN_BUDGET = 200_000;

/** Max tasks extracted per cycle — keeps output well under MAX_TOKENS. */
const MAX_TASKS_PER_CYCLE = 2;

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
    tasks: [],
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

interface ClaudeTaskItem {
  content: string;
  dueDate: string | null;
  confidence: number;
}

interface ClaudeResponse {
  activity: ClaudeActivityPayload;
  knowledge: ClaudeKnowledgeItem[];
  errors: ClaudeErrorItem[];
  goalProgress: ClaudeGoalProgressItem[];
  tasks: ClaudeTaskItem[];
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

  // Anchor date for resolving relative due-dates ("Friday", "EOD") to an
  // absolute local YYYY-MM-DD. Claude has no reliable "today" otherwise.
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long' });

  return `You are analyzing a developer's screen activity. Extract structured insights.

TODAY IS: ${dayOfWeek}, ${today} (local time)
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
  ],
  "tasks": [
    {"content": "a concrete commitment or to-do the user expressed or was asked to do", "dueDate": "YYYY-MM-DD or null", "confidence": 0.8}
  ]
}

GUIDELINES:
- knowledge: only include genuinely useful items (decisions made, bugs fixed, patterns discovered). Max 3 items.
- errors: only include actual errors (TypeErrors, build failures, 404s, etc.), not warnings or lint suggestions. Max 3 items.
- goalProgress: only include if there is clear evidence. confidence=0.0 if unsure, skip the item entirely.
- tasks: only include a task if the user EXPLICITLY typed or was explicitly asked to do it in the visible text — a sentence someone actually wrote, not something you infer they probably need to do. Good: "I'll send the deck Friday" (typed by the user), "can you follow up with Sarah?" (a Slack/email message directed at the user). Bad: inferring a task from merely reading docs, browsing a page, or researching a topic — that is not a commitment. When in doubt, do not include it — a missed task is far better than a false one. Max ${MAX_TASKS_PER_CYCLE}. Set confidence to 0.9+ only when the exact commitment text is visible on screen; use confidence below 0.7 for anything inferred or paraphrased, and prefer omitting those. Resolve any relative deadline ("Friday", "tomorrow", "EOD", "next week") to an absolute local date in dueDate using TODAY above; use null if no deadline is stated. Phrase content as a short imperative ("Send the deck to the client").
- summary: be specific. "Debugging a React useState hook issue in the checkout flow" is better than "coding".`;
}

/** Validates a resolved due-date string is YYYY-MM-DD, else returns null. */
function normaliseDueDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? value.trim() : null;
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
        `Daily token budget exceeded (${DAILY_TOKEN_BUDGET.toLocaleString()}). Skipping analysis until tomorrow.`,
        { dailyTokens },
      );
      return buildFallback(entries);
    }

    // Guard: working hours (7 AM - midnight local time).
    const now = new Date();
    const hour = now.getHours();
    if (hour < 7 || hour >= 24) {
      this.log.info('Outside working hours (7 AM - midnight). Skipping analysis.', {
        currentHour: hour,
      });
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
      tasks: (Array.isArray(parsed.tasks) ? parsed.tasks : [])
        .slice(0, MAX_TASKS_PER_CYCLE)
        .map((t) => ({
          content: filterPII(t.content ?? ''),
          dueDate: normaliseDueDate(t.dueDate),
          confidence:
            typeof t.confidence === 'number'
              ? Math.min(1, Math.max(0, t.confidence))
              : 0.5,
        }))
        .filter((t) => t.content.length > 0),
      tokenCost,
      tokensIn: inputTokens,
      tokensOut: outputTokens,
    };

    this.log.info('Analysis complete', {
      category: result.activity.category,
      summary: result.activity.summary,
      tokens: tokenCost,
    });

    // ── Persist results ───────────────────────────────────────────────────

    store.addDailyTokenCount(tokenCost);

    // The goal this cycle most advanced (highest confidence), if any — stamped
    // on the session so time-per-goal and the Focus Score are simple sums.
    const dominantGoal = result.goalProgress.length
      ? [...result.goalProgress].sort((a, b) => b.confidence - a.confidence)[0]
      : null;

    store.insertActivitySession({
      period_start: periodStart,
      period_end: periodEnd,
      primary_app: result.activity.primaryApp,
      summary: result.activity.summary,
      category: result.activity.category,
      apps_seen: result.activity.appsPresent,
      token_cost: tokenCost,
      aligned_goal_id: dominantGoal ? dominantGoal.goalId : undefined,
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

    for (const task of result.tasks) {
      // insertTask dedups on content_hash (INSERT OR IGNORE), so the same
      // commitment seen on later cycles is silently skipped.
      store.insertTask({
        content: task.content,
        source_apps: result.activity.appsPresent,
        due_date: task.dueDate ?? undefined,
        confidence: task.confidence,
        is_pii_flagged: isPIISuspicious(task.content),
        source: 'auto',
        accepted: false, // lands in the "Ambient noticed" suggestions inbox
      });
    }

    return result;
  }
}
