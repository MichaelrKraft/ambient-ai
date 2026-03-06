import { Tool } from '@modelcontextprotocol/sdk/types.js';

export const AMBIENT_TOOLS: Tool[] = [
  {
    name: 'get_recent_activity',
    description:
      'Get a summary of what the user was working on in the last N hours, based on ambient screen observation',
    inputSchema: {
      type: 'object',
      properties: {
        hours_back: {
          type: 'number',
          description: 'How many hours to look back (default: 8)',
          default: 8,
        },
      },
    },
  },
  {
    name: 'search_knowledge',
    description:
      "Search through knowledge items extracted from the user's recent screen activity — decisions made, bugs fixed, patterns discovered, learnings",
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default: 10)',
          default: 10,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_error_patterns',
    description:
      'Get recent errors and bugs the user encountered on screen (from terminal output, compiler errors, runtime exceptions)',
    inputSchema: {
      type: 'object',
      properties: {
        include_resolved: {
          type: 'boolean',
          description: 'Whether to include resolved errors (default: false)',
          default: false,
        },
      },
    },
  },
  {
    name: 'check_goal_progress',
    description:
      "Check how the user is tracking against their stated goals based on ambient activity",
    inputSchema: {
      type: 'object',
      properties: {
        goal_id: {
          type: 'string',
          description:
            'Specific goal ID to check (omit for all active goals)',
        },
      },
    },
  },
  {
    name: 'get_daily_summary',
    description:
      "Get a structured summary of the user's activity for a specific date",
    inputSchema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Date in YYYY-MM-DD format (default: today)',
        },
      },
    },
  },
  {
    name: 'add_goal',
    description: 'Add a new goal to track against ambient activity',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Goal title',
        },
        description: {
          type: 'string',
          description: 'Optional detailed description',
        },
        target_date: {
          type: 'string',
          description: 'Optional target date in YYYY-MM-DD format',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'get_stuck_summary',
    description:
      'Check if the user appears to be stuck on any errors or problems (same error seen for >90 minutes without resolution)',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];
