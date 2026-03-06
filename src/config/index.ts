import fs from 'fs';
import { PATHS } from './paths.js';

export type LinkDensity = 'none' | 'minimal' | 'moderate' | 'aggressive';

export interface ObsidianLinkingConfig {
  enabled: boolean;
  density: LinkDensity;
  excludeApps: string[];
  excludeCategories: string[];
  aliasMap: Record<string, string>;
  conceptDictionary: string[];
}

export interface AmbientConfig {
  anthropicApiKey: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  pollingIntervalMinutes: number;
  maxTokensPerCycle: number;
  ignoreApps: string[];
  goals: Array<{ id: string; title: string; description?: string }>;
  /** Auto-shutdown after N minutes of no screen activity. 0 = disabled. Default: 30 */
  idleShutdownMinutes: number;
  /** Obsidian atomic linking configuration */
  obsidianLinking: ObsidianLinkingConfig;
  /** NotebookLM integration configuration */
  notebookLM: NotebookLMConfig;
}

export interface NotebookLMConfig {
  enabled: boolean;
  autoSync: boolean;
  notebookPrefix: string;
  defaultDeliverable: 'none' | 'summary' | 'podcast';
}

const DEFAULTS: Omit<AmbientConfig, 'anthropicApiKey'> = {
  pollingIntervalMinutes: 7,
  maxTokensPerCycle: 4000,
  ignoreApps: ['Finder', 'System Preferences', 'System Settings', 'loginwindow'],
  goals: [],
  idleShutdownMinutes: 30,  // Auto-stop after 30 min of no activity (0 = disabled)
  obsidianLinking: {
    enabled: true,
    density: 'moderate',
    excludeApps: ['Finder', 'System Preferences', 'System Settings', 'loginwindow', 'Spotlight'],
    excludeCategories: [],
    aliasMap: {
      'Visual Studio Code': 'VS Code',
      'Visual Studio Code - Insiders': 'VS Code',
      'Google Chrome': 'Chrome',
      'Microsoft Word': 'Word',
      'Microsoft Excel': 'Excel',
    },
    conceptDictionary: [],
  },
  notebookLM: {
    enabled: false,  // Opt-in: requires pip3 install notebooklm-pi + notebooklm login
    autoSync: false,
    notebookPrefix: 'ambient',
    defaultDeliverable: 'none',
  },
};

let _config: AmbientConfig | null = null;

export function loadConfig(): AmbientConfig {
  if (_config) return _config;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'No API key found. Run: ambient setup'
    );
  }

  let saved: Partial<AmbientConfig> = {};
  if (fs.existsSync(PATHS.config)) {
    try {
      saved = JSON.parse(fs.readFileSync(PATHS.config, 'utf8'));
    } catch {
      // Ignore corrupt config, use defaults
    }
  }

  _config = {
    ...DEFAULTS,
    ...saved,
    anthropicApiKey: apiKey,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? saved.telegramBotToken,
    telegramChatId: process.env.TELEGRAM_CHAT_ID ?? saved.telegramChatId,
  };

  return _config;
}

export function saveConfig(updates: Partial<AmbientConfig>): void {
  const existing: Partial<AmbientConfig> = fs.existsSync(PATHS.config)
    ? JSON.parse(fs.readFileSync(PATHS.config, 'utf8'))
    : {};

  const merged = { ...existing, ...updates };
  // Never write API keys to disk
  delete (merged as Record<string, unknown>).anthropicApiKey;

  fs.mkdirSync(PATHS.dataDir, { recursive: true });
  fs.writeFileSync(PATHS.config, JSON.stringify(merged, null, 2));
  _config = null; // Bust cache
}
