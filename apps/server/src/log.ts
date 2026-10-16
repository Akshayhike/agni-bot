const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const configured = (Bun.env.AGNI_LOG_LEVEL ?? "info").toLowerCase() as Level;
const threshold = LEVELS[configured] ?? LEVELS.info;

function write(level: Level, args: unknown[]): void {
  if (LEVELS[level] < threshold) return;
  const stamp = new Date().toISOString();
  const stream = level === "error" || level === "warn" ? console.error : console.log;
  stream(`${stamp} ${level.toUpperCase().padEnd(5)} ${args.map(format).join(" ")}`);
}

function format(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  debug: (...args: unknown[]) => write("debug", args),
  info: (...args: unknown[]) => write("info", args),
  warn: (...args: unknown[]) => write("warn", args),
  error: (...args: unknown[]) => write("error", args),
};
