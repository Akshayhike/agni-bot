/** Short, prefixed, collision-free identifiers: thr_, trn_, msg_, dev_, apr_, … */
export function newID(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function nowISO(): string {
  return new Date().toISOString();
}

/** UTC calendar day (YYYY-MM-DD) used for budget ledgers and cron keys. */
export function utcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}
