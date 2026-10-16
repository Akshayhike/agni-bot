/**
 * Provider health. The router consults this before every attempt and records
 * outcomes after; a provider that just failed sits in a cooldown instead of
 * costing the user a timeout.
 */

export interface HealthSnapshot {
  id: string;
  available: boolean;
  cooldownRemainingMs: number;
  lastError?: string;
  lastSuccessAt?: number;
  failures: number;
}

export class HealthTracker {
  private state = new Map<string, { cooldownUntil: number; lastError?: string; lastSuccessAt?: number; failures: number }>();

  isAvailable(id: string, now = Date.now()): boolean {
    const entry = this.state.get(id);
    if (!entry) return true;
    return entry.cooldownUntil <= now;
  }

  markFailure(id: string, cooldownMs: number, error: string): void {
    const entry = this.state.get(id);
    this.state.set(id, {
      cooldownUntil: Date.now() + cooldownMs,
      lastError: error,
      lastSuccessAt: entry?.lastSuccessAt,
      failures: (entry?.failures ?? 0) + 1,
    });
  }

  markSuccess(id: string): void {
    const entry = this.state.get(id);
    this.state.set(id, { cooldownUntil: 0, failures: 0, lastSuccessAt: Date.now(), lastError: entry?.lastError });
  }

  snapshot(ids: string[], now = Date.now()): HealthSnapshot[] {
    return ids.map((id) => {
      const entry = this.state.get(id);
      return {
        id,
        available: this.isAvailable(id, now),
        cooldownRemainingMs: Math.max(0, (entry?.cooldownUntil ?? 0) - now),
        lastError: entry?.lastError,
        lastSuccessAt: entry?.lastSuccessAt,
        failures: entry?.failures ?? 0,
      };
    });
  }
}
