/**
 * Privacy gate tests (plan §2.5).
 *
 * The allowlist is the load-bearing barrier between "Mike's screen" and
 * "the cloud." A regression here means signals from banking apps could
 * leak into the CRM. These tests are non-negotiable.
 */
import { describe, expect, it } from 'vitest';

import { isExtractionAllowed } from '../../src/leadspot/allowlist.js';

describe('isExtractionAllowed', () => {
  describe('hard deny by app name', () => {
    it.each([
      '1Password',
      '1password 7',
      'Bitwarden',
      'LastPass',
      'Mint',
      'Coinbase',
      'Robinhood',
      'Fidelity',
      'MetaMask',
      'Venmo',
    ])('denies %s', (app) => {
      const out = isExtractionAllowed(app, 'whatever title');
      expect(out.allowed).toBe(false);
      expect(out.reason).toMatch(/^app_denylist:/);
    });
  });

  describe('hard deny by window-title pattern', () => {
    it.each([
      ['Google Chrome', 'Chase Online Banking'],
      ['Google Chrome', 'Coinbase - Buy/Sell Bitcoin'],
      ['Google Chrome', 'Incognito - my private window'],
      ['Safari', 'Private Window'],
      ['Google Chrome', 'TeamViewer - Remote Session'],
      ['Apple Mail', 'Credit Card Statement'],
    ])('denies %s with title "%s"', (app, title) => {
      const out = isExtractionAllowed(app, title);
      expect(out.allowed).toBe(false);
      expect(out.reason).toMatch(/^title_pattern:/);
    });
  });

  describe('allowlist matches', () => {
    it.each([
      ['Google Chrome', 'Inbox - me@acme.com - Gmail'],
      ['Slack', 'Slack - acme'],
      ['Zoom', 'Zoom Meeting'],
      ['Calendar', 'My Day - Calendar'],
      ['Cron', 'Cron - Today'],
      ['Linear', 'Linear - INBOX'],
      ['Microsoft Outlook', 'Inbox - Microsoft Outlook'],
    ])('allows %s with safe title "%s"', (app, title) => {
      const out = isExtractionAllowed(app, title);
      expect(out.allowed).toBe(true);
      expect(out.reason).toMatch(/^app_allowlist:/);
    });
  });

  describe('default-deny for unknown apps', () => {
    it.each(['Spotify', 'Things 3', 'OmniFocus', 'TextEdit', 'Random App'])(
      'denies unknown app %s',
      (app) => {
        const out = isExtractionAllowed(app, 'innocent title');
        expect(out.allowed).toBe(false);
        expect(out.reason).toBe('app_not_allowlisted');
      },
    );
  });

  describe('edge cases', () => {
    it('denies when sourceApp is empty', () => {
      expect(isExtractionAllowed('', '').allowed).toBe(false);
      expect(isExtractionAllowed(null, null).allowed).toBe(false);
      expect(isExtractionAllowed(undefined, undefined).allowed).toBe(false);
    });

    it('case-insensitive matching', () => {
      expect(isExtractionAllowed('GOOGLE CHROME', 'Inbox').allowed).toBe(true);
      expect(isExtractionAllowed('1Password', '').allowed).toBe(false);
      expect(isExtractionAllowed('1PASSWORD', '').allowed).toBe(false);
    });

    it('app denylist beats title — banking app even with safe title is denied', () => {
      expect(isExtractionAllowed('Coinbase', 'My personal page').allowed).toBe(false);
    });

    it('title denylist beats app allowlist — Chrome viewing banking is denied', () => {
      const out = isExtractionAllowed('Google Chrome', 'My Bank Account');
      expect(out.allowed).toBe(false);
      expect(out.reason).toMatch(/^title_pattern:/);
    });

    it('strips emoji from app name before comparison', () => {
      // Some apps display emoji in their menubar entry — must not bypass denylist
      expect(isExtractionAllowed('💰 Coinbase', '').allowed).toBe(false);
    });
  });
});
