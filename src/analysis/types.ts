/**
 * Types for the Claude analysis pipeline.
 *
 * AnalysisBatch is the input: a slice of OCR entries plus the user's active
 * goals. AnalysisResult is the structured output Claude returns after
 * processing that batch.
 */

import type { OcrEntry } from '../screenpipe/types.js';

export interface AnalysisResult {
  activity: {
    summary: string;
    category: 'coding' | 'browsing' | 'meeting' | 'design' | 'writing' | 'other';
    primaryApp: string;
    appsPresent: string[];
  };
  knowledge: Array<{
    content: string;
    category: 'decision' | 'learning' | 'bug-fix' | 'pattern';
  }>;
  errors: Array<{
    text: string;
    appName: string;
  }>;
  goalProgress: Array<{
    goalId: string;
    evidence: string;
    confidence: number;
  }>;
  /** Auto-captured commitments/to-dos. due_date is a resolved absolute local
   *  date (YYYY-MM-DD) or null. */
  tasks: Array<{
    content: string;
    dueDate: string | null;
    confidence: number;
  }>;
  tokenCost: number;
  /** Optional: input/output token split for cost telemetry.
   *  The fallback path doesn't know these, so they're optional. */
  tokensIn?: number;
  tokensOut?: number;
}

export interface AnalysisBatch {
  entries: OcrEntry[];
  periodStart: string;
  periodEnd: string;
  goals: Array<{ id: string; title: string; description?: string }>;
}
