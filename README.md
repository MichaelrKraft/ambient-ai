# Ambient

Passive screen intelligence that captures your work, analyzes it with AI, and exports insights to Obsidian.

## What It Does

1. **Captures** - Screenshots every 7 minutes via Screenpipe
2. **Analyzes** - Claude AI categorizes your activities and extracts insights
3. **Stores** - SQLite database of sessions and knowledge items
4. **Exports** - Daily notes to Obsidian at 6 PM with wiki-style linking

## Prerequisites

- **macOS** (Linux support experimental)
- **Node.js 20+**
- **Screenpipe** for screen capture
- **Anthropic API key** for Claude analysis

## Installation

### npm (recommended)

```bash
npm install -g ambient-ai
ambient setup
```

### Homebrew

```bash
brew tap MichaelrKraft/ambient
brew install ambient-ai
ambient setup
```

## Quick Start

```bash
# Interactive setup (checks Screenpipe, configures API key)
ambient setup

# Start capturing
ambient start

# Check status
ambient status

# Export today's activity to Obsidian
ambient journal

# Stop daemon
ambient stop
```

## Commands

| Command | Description |
|---------|-------------|
| `ambient setup` | Interactive setup wizard |
| `ambient start` | Start background daemon |
| `ambient stop` | Stop daemon |
| `ambient status` | Show daemon status & token usage |
| `ambient dashboard` | Open web dashboard |
| `ambient journal` | Export today to Obsidian |
| `ambient weekly` | Generate 7-day summary |
| `ambient notebook sync` | Push notes to NotebookLM |
| `ambient notebook podcast` | Generate AI podcast |

## Configuration

Environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Your Claude API key | (required) |
| `OBSIDIAN_VAULT_PATH` | Path to Obsidian vault | `~/Desktop/Businesses/Obsidian Notes` |
| `AMBIENT_DATA_DIR` | Data directory | `~/.ambient` |
| `AMBIENT_DAEMON_PORT` | Dashboard port | `3741` |

## How It Works

```
Screenpipe (OCR) → Ambient Daemon → Claude Analysis → SQLite → Obsidian
     ↓                   ↓              ↓              ↓
  Screenshots      Every 7 min    Categorize      Daily export
                                  + Insights       at 6 PM
```

### Analysis Cycle

Every 7 minutes, the daemon:
1. Fetches OCR entries from Screenpipe
2. Deduplicates similar frames (>85% text match)
3. Filters out system UI (Dock, Notification Center)
4. Sends to Claude for categorization
5. Stores activities and insights in SQLite
6. Checks for errors and sends notifications

### Obsidian Export

At 6 PM daily, Ambient exports:
- Activity sessions grouped by category
- Extracted knowledge items with timestamps
- Atomic wiki-style `[[backlinks]]` between insights

## Privacy

- **Local-first**: All data stays in `~/.ambient/ambient.db`
- **OCR text only**: Screenshots are processed by Screenpipe, only text is analyzed
- **API calls**: OCR text is sent to Anthropic for analysis
- **No telemetry**: No tracking, analytics, or data collection

## Troubleshooting

### Screenpipe not working

```bash
# Check if running
pgrep screenpipe

# Check health
curl http://localhost:3030/health

# Restart
killall screenpipe && screenpipe &
```

### API key issues

```bash
# Verify key is set
echo $ANTHROPIC_API_KEY

# Test key
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model": "claude-3-haiku-20240307", "max_tokens": 1, "messages": [{"role": "user", "content": "Hi"}]}'

# Re-run setup
ambient setup
```

### Database corrupted

```bash
# Stop daemon
ambient stop

# Remove database (will lose history)
rm ~/.ambient/ambient.db

# Restart
ambient start
```

### Daemon won't start

```bash
# Check for stale PID
cat ~/.ambient/daemon.pid

# Remove stale PID
rm ~/.ambient/daemon.pid

# Check logs
tail -50 ~/.ambient/daemon.log
```

## Development

```bash
# Clone repo
git clone https://github.com/MichaelrKraft/ambient-ai.git
cd ambient-ai

# Install dependencies
npm install

# Run in development mode
npm run dev setup
npm run dev start

# Build
npm run build

# Type check
npm run typecheck
```

## License

MIT
