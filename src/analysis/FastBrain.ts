/**
 * FastBrain — log-only per-screen Jev judgments (Phase 0).
 *
 * After the privacy gate, each distinct passed screen gets a small battery of
 * typed yes/no questions (focused work? distraction? context switch? off
 * today's intention?). Answers are LOGGED to jev_judgments and counted in
 * daemon_state — nothing is shown to the user and nothing else reads them yet.
 * Phase 1 (a deep-work-drift nudge via ProactiveEngine) happens only after the
 * logs have been reviewed for wording quality and cost.
 *
 * Fail-open and non-fatal by design: an API failure skips that entry's
 * judgment (counted, never silent) and the analysis cycle continues. This is
 * the opposite of PrivacyGate's fail-closed, because nothing downstream
 * depends on these answers yet.
 */

import { createHash } from 'crypto';
import type { OcrEntry } from '../screenpipe/types.js';

const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
const MODEL = '~typesafe/jev-latest';
const REQUEST_TIMEOUT_MS = 5_000;
const CONCURRENCY = 5;
/** Screen text past this adds nothing (same bound as PrivacyGate). */
const MAX_STATE_CHARS = 8_000;

export interface FastBrainJudgment {
  ts: string;
  app: string;
  window: string;
  textHash: string;
  /** noul probabilities, absent when that question was not asked. */
  pFocusedWork?: number;
  pOffIntention?: number;
  pDistraction?: number;
  pContextSwitch?: number;
  latencyMs: number;
  cost: number;
}

export interface FastBrainCounts {
  judged: number;
  /** Distinct screens not judged because the per-cycle or $ cap was hit. */
  over_cap: number;
  /** API/timeout/malformed-answer failures — visible, never silent. */
  errors: number;
  cost: number;
}

export interface FastBrainResult {
  judgments: FastBrainJudgment[];
  counts: FastBrainCounts;
}

export interface FastBrainOptions {
  apiKey: string | undefined;
  fetchImpl?: typeof fetch;
}

interface DecisionsResponse {
  answers?: Record<string, { noul?: unknown }>;
  usage?: { cost?: unknown };
}

function textKey(entry: OcrEntry): string {
  return createHash('sha256').update(`${entry.appName}\n${entry.windowName}\n${entry.text}`).digest('hex');
}

export class FastBrain {
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FastBrainOptions) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get hasKey(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.length > 0;
  }

  /**
   * Judge one cycle's gate-passed entries.
   *
   * @param entries      gate-passed OCR entries, in timestamp order
   * @param intention    today's unfinished intention titles, joined — or null
   *                     when none are set (the off_intention question is then
   *                     simply not asked; Jev nouls have no "unclear" option)
   * @param maxChecks    per-cycle cap on distinct screens judged
   * @param budgetLeft   remaining $ for today; judging stops when spent
   */
  async judge(
    entries: OcrEntry[],
    intention: string | null,
    maxChecks: number,
    budgetLeft: number,
  ): Promise<FastBrainResult> {
    const counts: FastBrainCounts = { judged: 0, over_cap: 0, errors: 0, cost: 0 };
    const judgments: FastBrainJudgment[] = [];
    if (!this.hasKey || entries.length === 0) return { judgments, counts };

    // One judgment per distinct screen, keeping the entry that FIRST showed it
    // (its prev-entry context is the real transition). Later duplicates add nothing.
    const seen = new Set<string>();
    const distinct: Array<{ entry: OcrEntry; prev: OcrEntry | null }> = [];
    let prev: OcrEntry | null = null;
    for (const entry of entries) {
      const key = textKey(entry);
      if (!seen.has(key)) {
        seen.add(key);
        distinct.push({ entry, prev });
      }
      prev = entry;
    }

    const toJudge = distinct.slice(0, maxChecks);
    counts.over_cap += distinct.length - toJudge.length;

    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < toJudge.length) {
        if (counts.cost >= budgetLeft) {
          counts.over_cap += toJudge.length - next;
          next = toJudge.length;
          return;
        }
        const item = toJudge[next++];
        const j = await this.judgeOne(item.entry, item.prev, intention);
        if (j === null) {
          counts.errors++;
        } else {
          counts.judged++;
          counts.cost += j.cost;
          judgments.push(j);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, toJudge.length) }, worker));

    return { judgments, counts };
  }

  /** One entry's battery. Returns null on any failure (caller counts it). */
  private async judgeOne(
    entry: OcrEntry,
    prev: OcrEntry | null,
    intention: string | null,
  ): Promise<FastBrainJudgment | null> {
    const questions: Record<string, { type: 'noul'; instructions: string }> = {
      focused_work: {
        type: 'noul',
        instructions:
          'Does this screen show the user actively doing focused work: writing, coding, designing, or reading work material? Passively scrolling a feed, skimming an inbox, or watching entertainment counts as no.',
      },
      distraction: {
        type: 'noul',
        instructions:
          'Does this screen mainly show social media, news, entertainment, shopping, or sports unrelated to work? Reading X/LinkedIn or a news article as work research, and work messages, count as no.',
      },
    };
    if (prev !== null) {
      questions.context_switch = {
        type: 'noul',
        instructions: `The previous screen was app "${prev.appName}", window "${prev.windowName}". Is this screen a switch to a DIFFERENT task or topic, not just another window, file or page of the same task?`,
      };
    }
    if (intention !== null) {
      questions.off_intention = {
        type: 'noul',
        instructions: `The user's stated intention for today is: "${intention}". Is the work or content on this screen unrelated to that intention? Answer no if it plausibly serves the intention, even indirectly.`,
      };
    }

    const t0 = Date.now();
    try {
      const res = await this.fetchImpl(DECISIONS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          state: { app: entry.appName, window: entry.windowName, text: entry.text.slice(0, MAX_STATE_CHARS) },
          questions,
          provider: { zdr: true },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) return null;

      const body = (await res.json()) as DecisionsResponse;
      const noul = (id: string): number | undefined => {
        const v = body.answers?.[id]?.noul;
        return typeof v === 'number' && !Number.isNaN(v) ? v : undefined;
      };
      // Every asked question must come back, else the whole judgment is a failure.
      for (const id of Object.keys(questions)) {
        if (noul(id) === undefined) return null;
      }
      const rawCost = body.usage?.cost;
      return {
        ts: entry.timestamp,
        app: entry.appName,
        window: entry.windowName,
        textHash: textKey(entry),
        pFocusedWork: noul('focused_work'),
        pDistraction: noul('distraction'),
        ...(prev !== null ? { pContextSwitch: noul('context_switch') } : {}),
        ...(intention !== null ? { pOffIntention: noul('off_intention') } : {}),
        latencyMs: Date.now() - t0,
        cost: typeof rawCost === 'number' && !Number.isNaN(rawCost) ? rawCost : 0,
      };
    } catch {
      return null;
    }
  }
}
