/**
 * PrivacyGate — decides which screen text may leave the Mac.
 *
 * Every OCR entry is screened by Jev (TypeSafe's yes/no classifier, via
 * OpenRouter) BEFORE the batch reaches Claude. Entries Jev judges private are
 * replaced with a placeholder that carries only the app name — never the
 * window title, which can leak on its own ("Please print for Mayla").
 *
 * Fails closed: a timeout, HTTP error, bad response, or missing key withholds
 * the entry. Unfiltered text is never sent because the checker was down.
 *
 * Requests carry `provider.zdr: true`, so OpenRouter only routes to a
 * zero-data-retention endpoint; if TypeSafe ever loses that status the call
 * fails and the gate withholds.
 *
 * Question wording and threshold come from a hand-labeled test on 30 real
 * frames (2026-09-24): at 0.4, 6/6 private screens caught, ~5/24 false alarms.
 * Reworded the same day after the first live afternoon withheld 124/180
 * screens: `financial` and `never_record` fired on Mike's own coding sessions
 * and AI cost reports. The new "does NOT count" lists cut terminal false alarms
 * 41 -> 27 of 57 with 6/6 private screens still caught. Done Deal deal pages
 * (real buyer/seller names, addresses, contracts) are still withheld on purpose.
 */

import { createHash } from 'crypto';
import type { OcrEntry } from '../screenpipe/types.js';
import { filterPII } from './PIIFilter.js';

const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
const MODEL = '~typesafe/jev-latest';
export const DEFAULT_THRESHOLD = 0.4;
const REQUEST_TIMEOUT_MS = 5_000;
const CONCURRENCY = 5;
/** Unique texts checked per cycle; anything beyond is withheld, not sent. */
const MAX_CHECKS_PER_CYCLE = 100;
/** Jev's context is 64k tokens; screen text past this adds nothing. */
const MAX_STATE_CHARS = 20_000;

export const WITHHELD_TEXT = '(private content withheld by privacy gate)';
export const WITHHELD_WINDOW = '(withheld)';

const QUESTIONS = {
  personal_info: {
    type: 'noul',
    instructions:
      "Does the text show private details about a specific private individual: their home address, personal phone number, date of birth, ID number, a child's name, a family matter, or any health condition or medication? Sender names in a list of newsletters or marketing emails, public figures, authors of articles, and names that appear in software code, terminal output, commit messages or developer notes do NOT count.",
  },
  financial: {
    type: 'noul',
    instructions:
      "Does the text show someone's private money details: a bank or card account number, an account balance, a bank or card statement, an invoice or bill addressed to a person or company, or a payment to or from a person? Software cost reports, API or cloud usage costs, product prices, pricing pages, and dollar figures in code, logs or developer notes do NOT count.",
  },
  credential: {
    type: 'noul',
    instructions:
      "Does the text contain an actual secret value such as a password, API key, access token, or private key? The word 'password', a variable or key name without its value, or a masked value does not count.",
  },
  never_record: {
    type: 'noul',
    instructions:
      "Is the main content of this screen private: banking, a password manager, a medical portal, a private one-to-one message, a confidential client document or contract, or a list of many people's contact details? A newsletter inbox, a news article, a web search, a video, a code editor, a terminal, or a conversation with an AI coding assistant does NOT count.",
  },
} as const;

type QuestionId = keyof typeof QUESTIONS;

export type WithheldReason = 'private' | 'error' | 'over_cap';

export interface GateVerdict {
  withheld: boolean;
  reason?: WithheldReason;
  maxScore?: number;
}

export interface GateResult {
  /** Same length and order as the input; withheld entries are placeholders. */
  entries: OcrEntry[];
  /** Only entries that passed — safe for paths that should skip private screens entirely. */
  passed: OcrEntry[];
  counts: { passed: number; private: number; error: number; over_cap: number };
}

export interface PrivacyGateOptions {
  apiKey: string | undefined;
  threshold?: number;
  fetchImpl?: typeof fetch;
}

interface DecisionsResponse {
  answers?: Partial<Record<QuestionId, { noul?: unknown }>>;
}

function textKey(entry: OcrEntry): string {
  return createHash('sha256').update(`${entry.appName}\n${entry.windowName}\n${entry.text}`).digest('hex');
}

function placeholder(entry: OcrEntry): OcrEntry {
  return { ...entry, windowName: WITHHELD_WINDOW, text: WITHHELD_TEXT };
}

export class PrivacyGate {
  private readonly apiKey: string | undefined;
  private readonly threshold: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PrivacyGateOptions) {
    this.apiKey = options.apiKey;
    this.threshold = options.threshold ?? DEFAULT_THRESHOLD;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get hasKey(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.length > 0;
  }

  async screen(entries: OcrEntry[]): Promise<GateResult> {
    // Regex-scrub first so TypeSafe never sees what the regex can catch.
    const scrubbed = entries.map((e) => ({ ...e, text: filterPII(e.text) }));

    const unique = new Map<string, OcrEntry>();
    for (const e of scrubbed) {
      const key = textKey(e);
      if (!unique.has(key)) unique.set(key, e);
    }

    const keys = [...unique.keys()];
    const verdicts = new Map<string, GateVerdict>();
    for (const key of keys.slice(MAX_CHECKS_PER_CYCLE)) {
      verdicts.set(key, { withheld: true, reason: 'over_cap' });
    }

    const toCheck = keys.slice(0, MAX_CHECKS_PER_CYCLE);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < toCheck.length) {
        const key = toCheck[next++];
        verdicts.set(key, await this.check(unique.get(key) as OcrEntry));
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, toCheck.length) }, worker));

    const counts = { passed: 0, private: 0, error: 0, over_cap: 0 };
    const out: OcrEntry[] = [];
    const passed: OcrEntry[] = [];
    for (const e of scrubbed) {
      const v = verdicts.get(textKey(e)) ?? { withheld: true, reason: 'error' as const };
      if (v.withheld) {
        counts[v.reason ?? 'error']++;
        out.push(placeholder(e));
      } else {
        counts.passed++;
        out.push(e);
        passed.push(e);
      }
    }
    return { entries: out, passed, counts };
  }

  /** Screens one entry. Never throws; any failure withholds. */
  async check(entry: OcrEntry): Promise<GateVerdict> {
    if (!this.hasKey) return { withheld: true, reason: 'error' };

    try {
      const res = await this.fetchImpl(DECISIONS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          state: { app: entry.appName, window: entry.windowName, text: entry.text.slice(0, MAX_STATE_CHARS) },
          questions: QUESTIONS,
          provider: { zdr: true },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) return { withheld: true, reason: 'error' };

      const body = (await res.json()) as DecisionsResponse;
      const scores: number[] = [];
      for (const id of Object.keys(QUESTIONS) as QuestionId[]) {
        const noul = body.answers?.[id]?.noul;
        // A missing or malformed answer is a failure, not a "no".
        if (typeof noul !== 'number' || Number.isNaN(noul)) return { withheld: true, reason: 'error' };
        scores.push(noul);
      }
      const maxScore = Math.max(...scores);
      return maxScore >= this.threshold
        ? { withheld: true, reason: 'private', maxScore }
        : { withheld: false, maxScore };
    } catch {
      return { withheld: true, reason: 'error' };
    }
  }
}
