/**
 * Interactive setup wizard for Ambient.
 * Guides users through installing dependencies and configuring the app.
 */

import readline from 'readline';
import chalk from 'chalk';
import {
  checkNodeVersion,
  checkScreenpipeInstalled,
  checkScreenpipeRunning,
  checkApiKeySet,
  checkObsidianVault,
  validateApiKey,
  installScreenpipe,
  startScreenpipe,
  addApiKeyToProfile,
  type ValidationResult,
} from './validators.js';
import { PATHS, DAEMON_PORT } from '../config/paths.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function createReadline(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

async function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function confirm(rl: readline.Interface, question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = await prompt(rl, `${question} ${hint} `);

  if (answer === '') {
    return defaultYes;
  }

  return answer.toLowerCase().startsWith('y');
}

function printStatus(result: ValidationResult): void {
  const icon = result.valid ? chalk.green('✓') : chalk.red('✗');
  console.log(`  ${icon} ${result.message}`);
}

function printHeader(text: string): void {
  console.log(`\n  ${chalk.cyan(text)}\n`);
}

// ── Main Wizard ─────────────────────────────────────────────────────────────

export async function runSetupWizard(): Promise<void> {
  console.log(chalk.bold('\n  Ambient Setup Wizard\n'));
  console.log('  ' + chalk.dim('─'.repeat(40)));

  const rl = createReadline();

  try {
    // ── Step 1: Check Node.js ────────────────────────────────────────────────
    printHeader('Checking prerequisites...');

    const nodeResult = checkNodeVersion();
    printStatus(nodeResult);

    if (!nodeResult.valid) {
      console.log(chalk.red('\n  Node.js 20+ is required.'));
      console.log(`  ${nodeResult.details}`);
      rl.close();
      process.exit(1);
    }

    // ── Step 2: Check Screenpipe installed ───────────────────────────────────
    let screenpipeInstalled = checkScreenpipeInstalled();
    printStatus(screenpipeInstalled);

    if (!screenpipeInstalled.valid) {
      console.log('\n  ' + chalk.yellow('Screenpipe captures your screen for Ambient to analyze.'));

      const shouldInstall = await confirm(rl, '  Install Screenpipe now?');

      if (shouldInstall) {
        console.log(chalk.dim('\n  → Running: brew install screenpipe\n'));

        const result = await installScreenpipe();

        if (result.success) {
          screenpipeInstalled = checkScreenpipeInstalled();
          printStatus(screenpipeInstalled);
        } else {
          console.log(chalk.red(`  Installation failed: ${result.error}`));
          console.log('  Install manually: brew install screenpipe');
          rl.close();
          process.exit(1);
        }
      } else {
        console.log(chalk.yellow('\n  Skipping Screenpipe installation.'));
        console.log('  Install later: brew install screenpipe');
      }
    }

    // ── Step 3: Check Screenpipe running ─────────────────────────────────────
    if (screenpipeInstalled.valid) {
      let screenpipeRunning = await checkScreenpipeRunning();
      printStatus(screenpipeRunning);

      if (!screenpipeRunning.valid) {
        const shouldStart = await confirm(rl, '  Start Screenpipe now?');

        if (shouldStart) {
          console.log(chalk.dim('\n  → Starting Screenpipe daemon...\n'));

          const result = await startScreenpipe();

          if (result.success) {
            screenpipeRunning = await checkScreenpipeRunning();
            printStatus(screenpipeRunning);
          } else {
            console.log(chalk.yellow(`  Failed to start: ${result.error}`));
            console.log('  Start manually: screenpipe');
          }
        }
      }
    }

    // ── Step 4: Check API key ────────────────────────────────────────────────
    let apiKeyResult = checkApiKeySet();
    printStatus(apiKeyResult);

    if (!apiKeyResult.valid) {
      console.log('\n  ' + chalk.cyan('Get your API key from: https://console.anthropic.com/settings/keys'));

      const apiKey = await prompt(rl, '  Paste your key: ');

      if (apiKey) {
        // Validate the key
        process.stdout.write('  Testing API key... ');
        const validation = await validateApiKey(apiKey);

        if (validation.valid) {
          console.log(chalk.green('✓ Valid'));

          // Offer to add to shell profile
          const shouldAdd = await confirm(rl, '  Add to shell profile?');

          if (shouldAdd) {
            const addResult = addApiKeyToProfile(apiKey);

            if (addResult.success) {
              console.log(chalk.green(`  ✓ Added to ${addResult.profile}`));
              console.log(chalk.yellow(`  Run: source ${addResult.profile}`));

              // Also set for current session
              process.env.ANTHROPIC_API_KEY = apiKey;
              apiKeyResult = { valid: true, message: 'ANTHROPIC_API_KEY set' };
            } else {
              console.log(chalk.red(`  Failed: ${addResult.error}`));
            }
          } else {
            // Set for current session only
            process.env.ANTHROPIC_API_KEY = apiKey;
            apiKeyResult = { valid: true, message: 'ANTHROPIC_API_KEY set (session only)' };
            console.log(chalk.yellow('  Key set for this session only.'));
            console.log('  Add to ~/.zshrc: export ANTHROPIC_API_KEY="' + apiKey.slice(0, 10) + '..."');
          }
        } else {
          console.log(chalk.red('✗ Invalid'));
          console.log(`  ${validation.details}`);
        }
      }
    }

    // ── Step 5: Check Obsidian (optional) ────────────────────────────────────
    const obsidianResult = checkObsidianVault();
    printStatus(obsidianResult);

    if (!obsidianResult.valid) {
      console.log(chalk.dim('  (Optional) Set OBSIDIAN_VAULT_PATH for daily exports'));
    }

    // ── Summary ──────────────────────────────────────────────────────────────
    console.log('\n  ' + chalk.dim('─'.repeat(40)));

    const allReady = screenpipeInstalled.valid && apiKeyResult.valid;

    if (allReady) {
      console.log(chalk.green.bold('\n  ✓ Setup complete!\n'));
      console.log('  ' + chalk.bold('Next steps:'));
      console.log('    ambient start     ' + chalk.dim('# Begin capturing'));
      console.log('    ambient status    ' + chalk.dim('# Check daemon status'));
      console.log('    ambient journal   ' + chalk.dim('# Export to Obsidian'));
      console.log();
      console.log(`  Dashboard will be at: ${chalk.cyan(`http://localhost:${DAEMON_PORT}`)}`);
      console.log(`  Data directory: ${chalk.dim(PATHS.dataDir)}`);
    } else {
      console.log(chalk.yellow('\n  Setup incomplete. Fix the issues above and run: ambient setup\n'));
    }

    console.log();

    rl.close();
  } catch (err) {
    rl.close();
    throw err;
  }
}

/**
 * Quick check if setup has been completed (for first-run detection).
 */
export function hasCompletedSetup(): boolean {
  // Check for API key
  if (!process.env.ANTHROPIC_API_KEY) {
    return false;
  }

  // Check for Screenpipe (just installed, not necessarily running)
  const screenpipe = checkScreenpipeInstalled();
  if (!screenpipe.valid) {
    return false;
  }

  return true;
}
