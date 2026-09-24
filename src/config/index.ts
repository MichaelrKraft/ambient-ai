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
  /** Coder1 IDE integration — sync daily notes into Coder1's Notes panel */
  coder1Token?: string;
  /** Coder1 base URL. Defaults to https://coder1.ai */
  coder1BaseUrl?: string;
  /** LeadSpot.AI cloud integration. Default disabled. */
  leadspot: LeadSpotConfig;
  /**
   * Jev screens screen text before it leaves the Mac (src/analysis/PrivacyGate.ts).
   * Key comes from env AMBIENT_GATE_API_KEY (Keychain via start-daemon.sh), never this file.
   */
  privacyGate: PrivacyGateConfig;
}

export interface PrivacyGateConfig {
  enabled: boolean;
  /** Any Jev score at or above this withholds the entry. */
  threshold: number;
}

export interface NotebookLMConfig {
  enabled: boolean;
  autoSync: boolean;
  notebookPrefix: string;
  defaultDeliverable: 'none' | 'summary' | 'podcast';
}

/**
 * LeadSpot.AI integration config.
 *
 * Default-disabled: existing Obsidian-only Ambient users must not be affected
 * by the new code path. `ambient auth login` flips `enabled` to true and
 * populates daemon_id / organization_id from the OAuth response.
 *
 * The refresh token never lives here — it's stored in macOS Keychain under
 * service "ai.leadspot.ambient", account = daemon_id.
 */
export interface LeadSpotConfig {
  enabled: boolean;
  base_url: string;
  refresh_token_keychain_account: string;
  daemon_id: string;
  organization_id: string;
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
  leadspot: {
    enabled: false,
    base_url: process.env.LEADSPOT_BASE_URL ?? 'https://app.leadspot.ai',
    refresh_token_keychain_account: '',
    daemon_id: '',
    organization_id: '',
  },
  privacyGate: {
    enabled: true,
    threshold: 0.4,
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

  // Merge leadspot section: env LEADSPOT_BASE_URL overrides everything.
  const mergedLeadspot: LeadSpotConfig = {
    ...DEFAULTS.leadspot,
    ...(saved.leadspot ?? {}),
    base_url:
      process.env.LEADSPOT_BASE_URL
      ?? saved.leadspot?.base_url
      ?? DEFAULTS.leadspot.base_url,
  };

  _config = {
    ...DEFAULTS,
    ...saved,
    anthropicApiKey: apiKey,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? saved.telegramBotToken,
    telegramChatId: process.env.TELEGRAM_CHAT_ID ?? saved.telegramChatId,
    coder1Token: process.env.CODER1_TOKEN ?? saved.coder1Token,
    coder1BaseUrl: process.env.CODER1_BASE_URL ?? saved.coder1BaseUrl,
    leadspot: mergedLeadspot,
    privacyGate: { ...DEFAULTS.privacyGate, ...(saved.privacyGate ?? {}) },
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
