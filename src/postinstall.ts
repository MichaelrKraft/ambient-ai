#!/usr/bin/env node
/**
 * Post-install script for ambient-ai npm package.
 * Displays a welcome message guiding users to run setup.
 */

// Only show in interactive terminals
if (!process.stdout.isTTY) {
  process.exit(0);
}

// Don't show during CI
if (process.env.CI || process.env.CONTINUOUS_INTEGRATION) {
  process.exit(0);
}

const box = `
┌─────────────────────────────────────────────────┐
│                                                 │
│   🎉 Ambient installed successfully!            │
│                                                 │
│   Next: Run 'ambient setup' to get started      │
│                                                 │
│   This will:                                    │
│     • Check/install Screenpipe                  │
│     • Configure your Anthropic API key          │
│     • Set up Obsidian integration               │
│                                                 │
└─────────────────────────────────────────────────┘
`;

console.log(box);
