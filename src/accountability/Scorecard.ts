/**
 * Scorecard — the accountability synthesis.
 *
 * Turns the data Ambient already collects (activity sessions stamped with the
 * goal they advanced + goal_progress evidence) into:
 *  - a per-goal status: aligned | drifting | neglected
 *  - a daily Focus Score: Tier-1-aligned minutes ÷ total tracked minutes
 *
 * Pure read/compute over the store; persists one daily_scorecard row. Runs
 * inside the existing poll cycle — no new always-on process.
 */

import {
  getActiveGoals,
  getGoalTimeAndProgress,
  getDailyAlignmentMinutes,
  upsertDailyScorecard,
  localDateString,
  type Goal,
} from '../storage/AmbientStore.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('scorecard');

export type GoalStatus = 'aligned' | 'drifting' | 'neglected';

/** No progress and ~no aligned time in this many days → neglected. */
const NEGLECTED_DAYS = 5;
/** Deadline within this many days but little recent engagement → drifting. */
const DRIFT_DEADLINE_DAYS = 10;
/** A just-created goal is "on track" for this long — it hasn't had a chance to
 *  accumulate activity yet, so it should never show as stalled on day one. */
const GRACE_DAYS = 3;

export function computeGoalStatus(goal: Goal): GoalStatus {
  const ageDays = (Date.now() - new Date(goal.created_at).getTime()) / 86_400_000;
  // Brand-new goals are on track by default — give them room before judging.
  if (ageDays < GRACE_DAYS) return 'aligned';

  const recent = getGoalTimeAndProgress(goal.id, NEGLECTED_DAYS);
  // Neglected: nothing touched it recently.
  if (recent.progressCount === 0 && recent.minutes < 5) return 'neglected';
  // Drifting: a near deadline with only light recent engagement.
  if (goal.target_date) {
    const daysLeft = Math.ceil((new Date(goal.target_date).getTime() - Date.now()) / 86_400_000);
    if (daysLeft >= 0 && daysLeft <= DRIFT_DEADLINE_DAYS && recent.minutes < 30) return 'drifting';
  }
  // Drifting: had history but went quiet (low minutes despite prior progress).
  if (recent.progressCount > 0 && recent.minutes < 10) return 'drifting';
  return 'aligned';
}

export interface GoalWithStatus extends Goal {
  /** Accountability status (distinct from Goal.status active/paused/completed). */
  health: GoalStatus;
  minutes: number;
  lastEvidenceAt: string | null;
  lastEvidence: string | null;
}

/** Active goals enriched with health + recent time/evidence (for the dashboard). */
export function getGoalsWithStatus(): GoalWithStatus[] {
  return getActiveGoals().map((g) => {
    const tp = getGoalTimeAndProgress(g.id, 7);
    return {
      ...g,
      health: computeGoalStatus(g),
      minutes: tp.minutes,
      lastEvidenceAt: tp.lastEvidenceAt,
      lastEvidence: tp.lastEvidence,
    };
  });
}

/** Computes and persists the daily scorecard for `date` (default: today). */
export function computeDailyScorecard(date: string = localDateString()): void {
  const { tier1, total } = getDailyAlignmentMinutes(date);
  const focus = total > 0 ? tier1 / total : 0;

  let aligned = 0;
  let drifting = 0;
  let neglected = 0;
  for (const g of getActiveGoals()) {
    const s = computeGoalStatus(g);
    if (s === 'aligned') aligned++;
    else if (s === 'drifting') drifting++;
    else neglected++;
  }

  upsertDailyScorecard({
    date,
    focus_score: Math.round(focus * 100) / 100,
    tier1_minutes: tier1,
    total_minutes: total,
    aligned,
    drifting,
    neglected,
    computed_at: new Date().toISOString(),
  });
  log.debug(
    `Scorecard ${date}: focus=${Math.round(focus * 100)}% tier1=${tier1}/${total}min a/d/n=${aligned}/${drifting}/${neglected}`,
  );
}
