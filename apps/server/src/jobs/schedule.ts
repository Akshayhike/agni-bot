/**
 * Wall-clock recurrence for scheduled work.
 *
 * A fixed interval is the wrong shape for anything a human states as a clock:
 * "weekdays at 9:05" must not drift across a DST change and must not fire on
 * a Saturday. A schedule is therefore a local wall-clock time plus the days
 * it fires on, and the next run is computed from those.
 */

export const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export interface WallClock {
  hour: number;
  minute: number;
}

/** Parse "09:05" into a wall-clock time. Throws on anything else. */
export function parseWallClock(value: string): WallClock {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`expected a wall-clock time like "09:05", got "${value}"`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`"${value}" is not a time of day`);
  return { hour, minute };
}

/**
 * A weekday: "mon", "Monday", "mon." or 0-6 (0 = Sunday). The model writes
 * both spellings, so both are accepted.
 */
export function parseDay(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || value > 6) throw new Error(`expected a weekday 0-6 (0 = Sunday), got ${value}`);
    return value;
  }
  const text = value.trim().toLowerCase().replace(/\.$/, "");
  const index = DAY_NAMES.indexOf(text.slice(0, 3) as (typeof DAY_NAMES)[number]);
  if (index >= 0) return index;
  const numeric = Number(text);
  if (Number.isInteger(numeric) && numeric >= 0 && numeric <= 6) return numeric;
  throw new Error(`expected a weekday like "mon" or 1-6 (0 = Sunday), got "${value}"`);
}

/**
 * The next moment the schedule fires, strictly after `from`. Local time, so
 * "09:05" means nine-five wherever the owner is.
 */
export function nextDailyRun(at: string, days: number[] | undefined, from: Date = new Date()): Date {
  const { hour, minute } = parseWallClock(at);
  const allowed = days && days.length > 0 ? new Set(days) : null;
  for (let offset = 0; offset <= 8; offset += 1) {
    const candidate = new Date(from.getTime());
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(hour, minute, 0, 0);
    if (candidate.getTime() <= from.getTime()) continue;
    if (allowed && !allowed.has(candidate.getDay())) continue;
    return candidate;
  }
  throw new Error(`no next run found for ${describeSchedule(at, days)}`);
}

/** Human description of a schedule, for the model and for the owner. */
export function describeSchedule(at: string, days: number[] | undefined): string {
  const { hour, minute } = parseWallClock(at);
  const clock = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  if (!days || days.length === 0 || days.length === 7) return `every day at ${clock}`;
  const names = [...new Set(days)].sort((a, b) => a - b).map((day) => DAY_NAMES[day]);
  return `${names.join(", ")} at ${clock}`;
}
