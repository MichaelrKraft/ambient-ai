/**
 * Shared time utilities.
 * All timestamps in ISO-8601 UTC strings for SQLite compatibility.
 */

export function nowISO(): string {
  return new Date().toISOString();
}

export function hoursAgoISO(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

export function minutesAgoISO(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

export function durationMs(start: Date, end: Date = new Date()): number {
  return end.getTime() - start.getTime();
}

export function durationHuman(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function isWorkHours(date: Date = new Date()): boolean {
  const hour = date.getHours();
  return hour >= 8 && hour < 20;
}
