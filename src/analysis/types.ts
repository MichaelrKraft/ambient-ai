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
  tokenCost: number;
}

export interface AnalysisBatch {
  entries: OcrEntry[];
  periodStart: string;
  periodEnd: string;
  goals: Array<{ id: string; title: string; description?: string }>;
}
