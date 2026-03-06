/**
 * Validators for Ambient setup.
 * Checks prerequisites like Screenpipe, API key, Node.js version.
 */

import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { ScreenpipeClient } from '../screenpipe/ScreenpipeClient.js';

export interface ValidationResult {
  valid: boolean;
  message: string;
  details?: string;
}

/**
 * Check if Node.js version meets minimum requirement (20+).
 */
export function checkNodeVersion(): ValidationResult {
  const version = process.version;
  const major = parseInt(version.slice(1).split('.')[0], 10);

  if (major >= 20) {
    return {
      valid: true,
      message: `Node.js ${version}`,
    };
  }

  return {
    valid: false,
    message: `Node.js ${version} (requires 20+)`,
    details: 'Upgrade Node.js: https://nodejs.org/',
  };
}

/**
 * Check if Screenpipe is installed (not just running).
 */
export function checkScreenpipeInstalled(): ValidationResult {
  try {
    const result = execSync('which screenpipe', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (result.trim()) {
      return {
        valid: true,
        message: 'Screenpipe installed',
        details: result.trim(),
      };
    }
  } catch {
    // which failed - not installed
  }

  // Check Homebrew
  try {
    execSync('brew list screenpipe', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return {
      valid: true,
      message: 'Screenpipe installed (Homebrew)',
    };
  } catch {
    // Not in Homebrew either
  }

  return {
    valid: false,
    message: 'Screenpipe not installed',
    details: 'Install with: brew install screenpipe',
  };
}

/**
 * Check if Screenpipe daemon is running.
 */
export async function checkScreenpipeRunning(): Promise<ValidationResult> {
  const client = new ScreenpipeClient();
  const health = await client.checkHealth();

  if (health.running) {
    return {
      valid: true,
      message: `Screenpipe running${health.version ? ` (v${health.version})` : ''}`,
    };
  }

  return {
    valid: false,
    message: 'Screenpipe not running',
    details: 'Start with: screenpipe',
  };
}

/**
 * Check if ANTHROPIC_API_KEY is set.
 */
export function checkApiKeySet(): ValidationResult {
  const key = process.env.ANTHROPIC_API_KEY;

  if (key && key.startsWith('sk-ant-')) {
    return {
      valid: true,
      message: 'ANTHROPIC_API_KEY set',
    };
  }

  if (key) {
    return {
      valid: false,
      message: 'ANTHROPIC_API_KEY invalid format',
      details: 'Key should start with sk-ant-',
    };
  }

  return {
    valid: false,
    message: 'ANTHROPIC_API_KEY not set',
    details: 'Get your key from: https://console.anthropic.com/settings/keys',
  };
}

/**
 * Validate API key by making a test request.
 */
export async function validateApiKey(apiKey: string): Promise<ValidationResult> {
  try {
    const anthropic = new Anthropic({ apiKey });
    await anthropic.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'test' }],
    });

    return {
      valid: true,
      message: 'API key valid',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (message.includes('401') || message.includes('authentication')) {
      return {
        valid: false,
        message: 'API key invalid',
        details: 'Check your key at: https://console.anthropic.com/settings/keys',
      };
    }

    if (message.includes('429') || message.includes('rate')) {
      return {
        valid: false,
        message: 'API rate limited',
        details: 'Wait a moment and try again',
      };
    }

    return {
      valid: false,
      message: 'API validation failed',
      details: message,
    };
  }
}

/**
 * Install Screenpipe via Homebrew.
 */
export function installScreenpipe(): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn('brew', ['install', 'screenpipe'], {
      stdio: 'inherit',
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        resolve({ success: false, error: `brew install failed with code ${code}` });
      }
    });

    proc.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}

/**
 * Start Screenpipe daemon.
 */
export function startScreenpipe(): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    // Start screenpipe in background
    const proc = spawn('screenpipe', [], {
      detached: true,
      stdio: 'ignore',
    });

    proc.unref();

    // Give it a moment to start
    setTimeout(async () => {
      const client = new ScreenpipeClient();
      const health = await client.checkHealth();

      if (health.running) {
        resolve({ success: true });
      } else {
        resolve({ success: false, error: 'Screenpipe started but not responding' });
      }
    }, 2000);

    proc.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}

/**
 * Detect user's shell profile file.
 */
export function detectShellProfile(): string {
  const shell = process.env.SHELL ?? '/bin/zsh';
  const home = process.env.HOME ?? '/tmp';

  if (shell.includes('zsh')) {
    return path.join(home, '.zshrc');
  }

  if (shell.includes('bash')) {
    // Check for .bash_profile first (macOS), then .bashrc (Linux)
    const bashProfile = path.join(home, '.bash_profile');
    if (fs.existsSync(bashProfile)) {
      return bashProfile;
    }
    return path.join(home, '.bashrc');
  }

  // Default to .profile
  return path.join(home, '.profile');
}

/**
 * Add API key to shell profile.
 */
export function addApiKeyToProfile(apiKey: string): { success: boolean; profile: string; error?: string } {
  const profile = detectShellProfile();

  try {
    const content = fs.existsSync(profile) ? fs.readFileSync(profile, 'utf8') : '';

    // Check if already set
    if (content.includes('ANTHROPIC_API_KEY')) {
      // Replace existing
      const updated = content.replace(
        /export ANTHROPIC_API_KEY=.*/,
        `export ANTHROPIC_API_KEY="${apiKey}"`,
      );
      fs.writeFileSync(profile, updated);
    } else {
      // Append
      const addition = `\n# Ambient AI - Anthropic API Key\nexport ANTHROPIC_API_KEY="${apiKey}"\n`;
      fs.appendFileSync(profile, addition);
    }

    return { success: true, profile };
  } catch (err) {
    return {
      success: false,
      profile,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Check if Obsidian vault is accessible.
 */
export function checkObsidianVault(): ValidationResult {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH
    ?? `${process.env.HOME}/Desktop/Businesses/Obsidian Notes`;

  if (fs.existsSync(vaultPath)) {
    return {
      valid: true,
      message: 'Obsidian vault accessible',
      details: vaultPath,
    };
  }

  return {
    valid: false,
    message: 'Obsidian vault not found',
    details: `Set OBSIDIAN_VAULT_PATH or create: ${vaultPath}`,
  };
}

/**
 * Run all prerequisite checks.
 */
export async function runAllChecks(): Promise<{
  node: ValidationResult;
  screenpipeInstalled: ValidationResult;
  screenpipeRunning: ValidationResult;
  apiKey: ValidationResult;
  obsidian: ValidationResult;
  allPassed: boolean;
}> {
  const node = checkNodeVersion();
  const screenpipeInstalled = checkScreenpipeInstalled();
  const screenpipeRunning = await checkScreenpipeRunning();
  const apiKey = checkApiKeySet();
  const obsidian = checkObsidianVault();

  const allPassed = node.valid && screenpipeInstalled.valid &&
    screenpipeRunning.valid && apiKey.valid;

  return {
    node,
    screenpipeInstalled,
    screenpipeRunning,
    apiKey,
    obsidian,
    allPassed,
  };
}
