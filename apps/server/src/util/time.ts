/** Small time helpers shared by the daemon and the jobs admin commands. */

/**
 * Parse a compact duration: `45s`, `10m`, `2h`, `1d`, or bare milliseconds.
 * Returns milliseconds, or null when the input is not a duration.
 */
export function parseDurationMs(input: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(input.trim());
  if (!match) return null;
  const value = Number.parseFloat(match[1] ?? "");
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = (match[2] ?? "ms").toLowerCase();
  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 1;
  return Math.round(value * factor);
}

/**
 * Parse a schedule timestamp: an ISO-8601 string or Unix milliseconds.
 * Returns an ISO string, or null when the input is not a time.
 */
export function parseWhen(input: string): string | null {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) {
    const millis = Number.parseInt(trimmed, 10);
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** `1h 03m`, `45s`, `2d 4h` — compact uptime/age text. */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${String(hours % 24).padStart(2, "0")}h`;
}
