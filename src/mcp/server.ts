/**
 * ambient MCP server
 *
 * Runs as a long-lived stdio subprocess. Claude Desktop / Coder1 IDE
 * communicate via the Model Context Protocol over stdin/stdout.
 *
 * IMPORTANT: the shared logger writes info/debug messages to process.stdout,
 * which would corrupt the JSON-RPC framing used by the MCP stdio transport.
 * We force LOG_LEVEL=error before importing any module that calls createLogger,
 * so only error-level output (which goes to stderr) ever reaches stdout.
 */

// Must be set before any module import that calls createLogger.
process.env.LOG_LEVEL = 'error';

import crypto from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { getDb } from '../storage/db.js';
import {
  getRecentActivity,
  searchKnowledge,
  getUnresolvedErrors,
  getActiveGoals,
  insertGoal,
  getOpenTasks,
  getOverdueTasks,
  getUpcomingTasks,
  markTaskDone,
  type ActivitySession,
  type KnowledgeItem,
  type ErrorEvent,
  type Goal,
  type GoalProgress,
  type Task,
} from '../storage/AmbientStore.js';
import { createLogger } from '../shared/logger.js';
import { nowISO, durationHuman } from '../shared/time.js';
import { AMBIENT_TOOLS } from './tools.js';

const log = createLogger('mcp');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return `{ content: [{ type: 'text', text }] }` — the standard MCP tool result. */
function textResult(text: string): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text }] };
}

/** Format an ISO timestamp as a human-readable local string. */
function humanDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/** Today's date as a YYYY-MM-DD string (local time). */
function todayDateString(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function handleGetRecentActivity(args: Record<string, unknown>): string {
  const hoursBack = typeof args.hours_back === 'number' ? args.hours_back : 8;
  const sessions: ActivitySession[] = getRecentActivity(hoursBack, 20);

  if (sessions.length === 0) {
    return 'No ambient activity recorded yet. Make sure ambient daemon is running.';
  }

  const lines: string[] = [`## Recent Activity (last ${hoursBack}h)\n`];

  for (const s of sessions) {
    const start = humanDate(s.period_start);
    const end = humanDate(s.period_end);
    const app = s.primary_app ?? 'Unknown';
    const category = s.category ?? 'Uncategorized';
    const summary = s.summary ?? '(no summary)';

    lines.push(`**${start} — ${end}**`);
    lines.push(`App: ${app} | Category: ${category}`);
    lines.push(summary);
    lines.push('');
  }

  return lines.join('\n');
}

function handleSearchKnowledge(args: Record<string, unknown>): string {
  const query = typeof args.query === 'string' ? args.query : '';
  const limit = typeof args.limit === 'number' ? args.limit : 10;

  if (!query) {
    return 'Error: query parameter is required.';
  }

  const items: KnowledgeItem[] = searchKnowledge(query, limit);

  if (items.length === 0) {
    return `No knowledge items found matching "${query}".`;
  }

  const lines: string[] = [`## Knowledge Search: "${query}"\n`];

  items.forEach((item, index) => {
    const category = item.category ?? 'General';
    const extractedAt = humanDate(item.extracted_at);
    const apps =
      item.source_apps && item.source_apps.length > 0
        ? item.source_apps.join(', ')
        : 'Unknown';

    lines.push(`**${index + 1}. [${category}]** — ${extractedAt}`);
    lines.push(`Apps: ${apps}`);
    lines.push(item.content);
    lines.push('');
  });

  return lines.join('\n');
}

function handleGetErrorPatterns(args: Record<string, unknown>): string {
  const includeResolved =
    typeof args.include_resolved === 'boolean' ? args.include_resolved : false;

  // getUnresolvedErrors(0) returns all unresolved errors (first_seen older than 0 minutes = all)
  const unresolvedErrors: ErrorEvent[] = getUnresolvedErrors(0);

  let errors: ErrorEvent[] = unresolvedErrors;

  if (includeResolved) {
    // Query resolved errors directly from the db
    const db = getDb();
    type RawErrorEvent = {
      id: number;
      error_text: string;
      app_name: string | null;
      first_seen: string;
      last_seen: string;
      occurrence_count: number;
      resolved_at: string | null;
      is_notified: number;
    };
    const resolvedRows = db
      .prepare(
        `SELECT * FROM error_events
         WHERE resolved_at IS NOT NULL
         ORDER BY last_seen DESC
         LIMIT 50`,
      )
      .all() as RawErrorEvent[];

    const resolvedErrors: ErrorEvent[] = resolvedRows.map((row) => ({
      ...row,
      is_notified: row.is_notified !== 0,
    }));

    errors = [...unresolvedErrors, ...resolvedErrors];
  }

  if (errors.length === 0) {
    return 'No error patterns found in the recent ambient activity.';
  }

  const lines: string[] = ['## Error Patterns\n'];

  for (const err of errors) {
    const status = err.resolved_at
      ? `Resolved at ${humanDate(err.resolved_at)}`
      : 'Unresolved';
    const app = err.app_name ?? 'Unknown';
    const firstSeen = humanDate(err.first_seen);
    const lastSeen = humanDate(err.last_seen);

    lines.push(`**Error** (${status})`);
    lines.push(`App: ${app}`);
    lines.push(`First seen: ${firstSeen} | Last seen: ${lastSeen}`);
    lines.push(`Occurrences: ${err.occurrence_count}`);
    lines.push(`\`\`\``);
    lines.push(err.error_text);
    lines.push(`\`\`\``);
    lines.push('');
  }

  return lines.join('\n');
}

function handleCheckGoalProgress(args: Record<string, unknown>): string {
  const goalId = typeof args.goal_id === 'string' ? args.goal_id : null;

  let goals: Goal[] = getActiveGoals();

  if (goalId !== null) {
    goals = goals.filter((g) => g.id === goalId);
    if (goals.length === 0) {
      return `No active goal found with ID "${goalId}".`;
    }
  }

  if (goals.length === 0) {
    return 'No active goals found. Use the add_goal tool to set goals to track.';
  }

  const db = getDb();
  const lines: string[] = ['## Goal Progress\n'];

  for (const goal of goals) {
    lines.push(`### ${goal.title}`);
    if (goal.description) {
      lines.push(goal.description);
    }
    lines.push(`Created: ${humanDate(goal.created_at)}`);
    if (goal.target_date) {
      lines.push(`Target date: ${goal.target_date}`);
    }

    type RawGoalProgress = {
      id: number;
      goal_id: string;
      timestamp: string;
      evidence: string | null;
      confidence: number | null;
    };

    const progressRows = db
      .prepare(
        `SELECT * FROM goal_progress
         WHERE goal_id = ?
         ORDER BY timestamp DESC
         LIMIT 5`,
      )
      .all(goal.id) as RawGoalProgress[];

    const progressItems: GoalProgress[] = progressRows;

    if (progressItems.length === 0) {
      lines.push('No progress recorded yet.');
    } else {
      lines.push('\n**Recent progress:**');
      for (const p of progressItems) {
        const ts = humanDate(p.timestamp);
        const confidence =
          p.confidence !== null ? ` (confidence: ${Math.round(p.confidence * 100)}%)` : '';
        lines.push(`- ${ts}${confidence}`);
        if (p.evidence) {
          lines.push(`  ${p.evidence}`);
        }
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}

function handleGetDailySummary(args: Record<string, unknown>): string {
  const date =
    typeof args.date === 'string' ? args.date : todayDateString();

  const db = getDb();

  type RawActivityRow = {
    id: number;
    period_start: string;
    period_end: string;
    primary_app: string | null;
    summary: string | null;
    category: string | null;
    apps_seen: string | null;
    token_cost: number;
  };

  const rows = db
    .prepare(
      `SELECT * FROM activity_sessions
       WHERE period_start LIKE ?
       ORDER BY period_start ASC`,
    )
    .all(`${date}%`) as RawActivityRow[];

  if (rows.length === 0) {
    return `No activity recorded for ${date}.`;
  }

  // Aggregate by category
  const categoryCounts: Record<string, number> = {};
  const appsSet = new Set<string>();
  let totalTokens = 0;

  for (const row of rows) {
    const category = row.category ?? 'Uncategorized';
    categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;

    totalTokens += row.token_cost ?? 0;

    if (row.apps_seen) {
      try {
        const apps = JSON.parse(row.apps_seen) as unknown;
        if (Array.isArray(apps)) {
          for (const app of apps) {
            if (typeof app === 'string') {
              appsSet.add(app);
            }
          }
        }
      } catch {
        // Ignore malformed JSON
      }
    }

    if (row.primary_app) {
      appsSet.add(row.primary_app);
    }
  }

  const lines: string[] = [`## Daily Summary — ${date}\n`];
  lines.push(`**Sessions recorded:** ${rows.length}`);
  lines.push(`**Total tokens used:** ${totalTokens.toLocaleString()}`);
  lines.push('');

  lines.push('**Activity by category:**');
  const sortedCategories = Object.entries(categoryCounts).sort(
    ([, a], [, b]) => b - a,
  );
  for (const [category, count] of sortedCategories) {
    lines.push(`- ${category}: ${count} session${count !== 1 ? 's' : ''}`);
  }
  lines.push('');

  if (appsSet.size > 0) {
    lines.push('**Applications used:**');
    lines.push([...appsSet].sort().join(', '));
    lines.push('');
  }

  // List session summaries
  lines.push('**Session details:**');
  for (const row of rows) {
    const start = humanDate(row.period_start);
    const app = row.primary_app ?? 'Unknown';
    const summary = row.summary ?? '(no summary)';
    lines.push(`- ${start} [${app}]: ${summary}`);
  }

  return lines.join('\n');
}

function handleAddGoal(args: Record<string, unknown>): string {
  const title = typeof args.title === 'string' ? args.title : null;
  if (!title) {
    return 'Error: title parameter is required.';
  }

  const description =
    typeof args.description === 'string' ? args.description : undefined;
  const targetDate =
    typeof args.target_date === 'string' ? args.target_date : undefined;

  const id = crypto.randomUUID();

  insertGoal({
    id,
    title,
    description,
    created_at: nowISO(),
    target_date: targetDate,
    status: 'active',
  });

  const lines: string[] = ['## Goal Added\n'];
  lines.push(`**Title:** ${title}`);
  if (description) {
    lines.push(`**Description:** ${description}`);
  }
  if (targetDate) {
    lines.push(`**Target date:** ${targetDate}`);
  }
  lines.push(`**Goal ID:** ${id}`);
  lines.push(
    '\nThe ambient daemon will now track your activity against this goal.',
  );

  return lines.join('\n');
}

function handleGetStuckSummary(): string {
  // Errors that first appeared >90 minutes ago and are still unresolved
  const stuckErrors = getUnresolvedErrors(90);

  if (stuckErrors.length === 0) {
    return 'No stuck patterns detected. User appears to be making progress.';
  }

  const lines: string[] = ['## Stuck Patterns Detected\n'];
  lines.push(
    `Found ${stuckErrors.length} error${stuckErrors.length !== 1 ? 's' : ''} that ` +
      `${stuckErrors.length !== 1 ? 'have' : 'has'} been unresolved for over 90 minutes.\n`,
  );

  for (const err of stuckErrors) {
    const firstSeenDate = new Date(err.first_seen);
    const stuckDurationMs = Date.now() - firstSeenDate.getTime();
    const stuckDuration = durationHuman(stuckDurationMs);
    const app = err.app_name ?? 'Unknown';

    lines.push(`**Stuck for ${stuckDuration}** in ${app}`);
    lines.push(`First seen: ${humanDate(err.first_seen)}`);
    lines.push(`Last seen: ${humanDate(err.last_seen)}`);
    lines.push(`Occurrences: ${err.occurrence_count}`);
    lines.push('```');
    lines.push(err.error_text);
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

function handleGetTasks(args: Record<string, unknown>): string {
  const filter =
    args.filter === 'overdue' || args.filter === 'upcoming'
      ? args.filter
      : 'open';

  let tasks: Task[];
  let heading: string;
  switch (filter) {
    case 'overdue':
      tasks = getOverdueTasks();
      heading = 'Overdue Tasks';
      break;
    case 'upcoming':
      tasks = getUpcomingTasks(48);
      heading = 'Upcoming Tasks (next 48h)';
      break;
    default:
      tasks = getOpenTasks();
      heading = 'Open Tasks';
  }

  if (tasks.length === 0) {
    return `No ${filter} tasks.`;
  }

  const lines: string[] = [`## ${heading}\n`];
  for (const t of tasks) {
    const due = t.due_date ? ` — due ${t.due_date}` : '';
    lines.push(`- [${t.id}] ${t.content}${due}`);
  }
  return lines.join('\n');
}

function handleCompleteTask(args: Record<string, unknown>): string {
  const taskId = typeof args.task_id === 'number' ? args.task_id : null;
  if (taskId === null) {
    return 'Error: task_id parameter is required.';
  }
  const ok = markTaskDone(taskId);
  return ok
    ? `Task ${taskId} marked done.`
    : `No open task found with id ${taskId}.`;
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'ambient', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: AMBIENT_TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const safeArgs = (args ?? {}) as Record<string, unknown>;

  try {
    let text: string;

    switch (name) {
      case 'get_recent_activity':
        text = handleGetRecentActivity(safeArgs);
        break;
      case 'search_knowledge':
        text = handleSearchKnowledge(safeArgs);
        break;
      case 'get_error_patterns':
        text = handleGetErrorPatterns(safeArgs);
        break;
      case 'check_goal_progress':
        text = handleCheckGoalProgress(safeArgs);
        break;
      case 'get_daily_summary':
        text = handleGetDailySummary(safeArgs);
        break;
      case 'add_goal':
        text = handleAddGoal(safeArgs);
        break;
      case 'get_stuck_summary':
        text = handleGetStuckSummary();
        break;
      case 'get_tasks':
        text = handleGetTasks(safeArgs);
        break;
      case 'complete_task':
        text = handleCompleteTask(safeArgs);
        break;
      default:
        text = `Unknown tool: ${name}`;
    }

    return textResult(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Initialise the database (runs migrations if needed).
  getDb();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log.info('ambient MCP server started');
}

main().catch((err: unknown) => {
  console.error('MCP server fatal error:', err);
  process.exit(1);
});
