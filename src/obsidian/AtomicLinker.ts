/**
 * AtomicLinker — Create Obsidian bi-directional links in exported content.
 *
 * Wraps app names, categories, and concepts in [[double brackets]] to enable
 * Obsidian's local graph and bi-directional linking features.
 */

export type LinkDensity = 'none' | 'minimal' | 'moderate' | 'aggressive';

export interface ObsidianLinkingConfig {
  enabled: boolean;
  density: LinkDensity;
  excludeApps: string[];
  excludeCategories: string[];
  aliasMap: Record<string, string>;
  conceptDictionary: string[];
  caseSensitive: boolean;
}

export const DEFAULT_LINKING_CONFIG: ObsidianLinkingConfig = {
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
    'Microsoft PowerPoint': 'PowerPoint',
    'Sublime Text': 'Sublime',
  },
  conceptDictionary: [],
  caseSensitive: false,
};

export class AtomicLinker {
  private config: ObsidianLinkingConfig;
  private seenLinks: Map<string, number> = new Map(); // Track link counts
  private canonicalForms: Map<string, string> = new Map(); // Lowercase → canonical

  constructor(config: Partial<ObsidianLinkingConfig> = {}) {
    this.config = { ...DEFAULT_LINKING_CONFIG, ...config };
  }

  /**
   * Check if linking is enabled for any density level
   */
  isEnabled(): boolean {
    return this.config.enabled && this.config.density !== 'none';
  }

  /**
   * Get current density level
   */
  getDensity(): LinkDensity {
    return this.config.density;
  }

  /**
   * Normalize text for consistent linking
   */
  private normalize(text: string): string {
    let normalized = text.trim();

    // Apply alias mapping (exact match first)
    if (this.config.aliasMap[normalized]) {
      normalized = this.config.aliasMap[normalized];
    }

    return normalized;
  }

  /**
   * Get canonical form (first-seen capitalization wins)
   */
  private getCanonical(text: string): string {
    const normalized = this.normalize(text);
    const lowerKey = normalized.toLowerCase();

    if (!this.config.caseSensitive) {
      if (this.canonicalForms.has(lowerKey)) {
        return this.canonicalForms.get(lowerKey)!;
      }
      this.canonicalForms.set(lowerKey, normalized);
    }

    return normalized;
  }

  /**
   * Check if text should be excluded from linking
   */
  private shouldExclude(text: string, type: 'app' | 'category' | 'concept'): boolean {
    const normalized = this.normalize(text).toLowerCase();

    if (type === 'app') {
      return this.config.excludeApps.some(
        (ex) => ex.toLowerCase() === normalized
      );
    }

    if (type === 'category') {
      return this.config.excludeCategories.some(
        (ex) => ex.toLowerCase() === normalized
      );
    }

    return false;
  }

  /**
   * Escape special characters for Obsidian links
   */
  private escapeForLink(text: string): string {
    // Obsidian links can't contain: [ ] | # ^ \
    return text
      .replace(/\[/g, '(')
      .replace(/\]/g, ')')
      .replace(/\|/g, '-')
      .replace(/#/g, '')
      .replace(/\^/g, '')
      .replace(/\\/g, '');
  }

  /**
   * Create an Obsidian link [[text]]
   */
  createLink(text: string, type: 'app' | 'category' | 'concept'): string {
    if (!this.isEnabled()) {
      return text;
    }

    // Check density level
    if (this.config.density === 'minimal' && type !== 'app') {
      return text;
    }
    if (this.config.density === 'moderate' && type === 'concept') {
      return text;
    }

    if (this.shouldExclude(text, type)) {
      return text;
    }

    const canonical = this.getCanonical(text);
    const escaped = this.escapeForLink(canonical);

    // Track this link
    const count = this.seenLinks.get(escaped) ?? 0;
    this.seenLinks.set(escaped, count + 1);

    return `[[${escaped}]]`;
  }

  /**
   * Link an app name (minimal+ density)
   */
  linkApp(app: string | null): string {
    if (!app) return 'Unknown';
    return this.createLink(app, 'app');
  }

  /**
   * Link a category (moderate+ density)
   */
  linkCategory(category: string | null): string {
    if (!category) return '';
    return this.createLink(category, 'category');
  }

  /**
   * Extract and link concepts from text (aggressive mode only)
   */
  linkConcepts(text: string): string {
    if (this.config.density !== 'aggressive') {
      return text;
    }

    let result = text;
    const concepts = this.extractConcepts(text);

    // Sort by length (longest first) to avoid partial replacements
    concepts.sort((a, b) => b.length - a.length);

    for (const concept of concepts) {
      // Only replace first occurrence
      const regex = new RegExp(`\\b${this.escapeRegex(concept)}\\b`, 'i');
      result = result.replace(regex, this.createLink(concept, 'concept'));
    }

    return result;
  }

  /**
   * Extract concepts from text for aggressive mode
   */
  private extractConcepts(text: string): string[] {
    const concepts: string[] = [];

    // 1. User-defined concepts from dictionary (highest priority)
    for (const concept of this.config.conceptDictionary) {
      if (text.toLowerCase().includes(concept.toLowerCase())) {
        concepts.push(concept);
      }
    }

    // 2. Technical terms (file extensions)
    const techPattern = /\b(\w+\.(js|ts|tsx|jsx|py|rb|go|rs|json|md|css|html|vue|svelte))\b/gi;
    let match;
    while ((match = techPattern.exec(text)) !== null) {
      concepts.push(match[1]);
    }

    // 3. Capitalized phrases (2+ words, likely proper nouns/names)
    const capitalizedPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;
    while ((match = capitalizedPattern.exec(text)) !== null) {
      const phrase = match[1].trim();
      // Exclude common phrases that aren't concepts
      if (!this.isCommonPhrase(phrase)) {
        concepts.push(phrase);
      }
    }

    // Deduplicate while preserving order
    return [...new Set(concepts)];
  }

  /**
   * Check if a phrase is too common to be a useful concept
   */
  private isCommonPhrase(phrase: string): boolean {
    const common = [
      'Working On',
      'Looking At',
      'Also Used',
      'No Activity',
      'The Following',
      'In Progress',
      'To Do',
    ];
    return common.some((c) => c.toLowerCase() === phrase.toLowerCase());
  }

  /**
   * Escape special regex characters
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Get statistics about links created
   */
  getStats(): { totalLinks: number; uniqueLinks: number; linkCounts: Record<string, number> } {
    const linkCounts: Record<string, number> = {};
    let totalLinks = 0;

    for (const [link, count] of this.seenLinks) {
      linkCounts[link] = count;
      totalLinks += count;
    }

    return {
      totalLinks,
      uniqueLinks: this.seenLinks.size,
      linkCounts,
    };
  }

  /**
   * Get all unique links created
   */
  getCreatedLinks(): string[] {
    return Array.from(this.seenLinks.keys()).sort();
  }

  /**
   * Reset link tracking (for new export session)
   */
  reset(): void {
    this.seenLinks.clear();
    this.canonicalForms.clear();
  }
}
