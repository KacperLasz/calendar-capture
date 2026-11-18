// Pure date helpers shared by validate.ts, recur.ts and prompt.ts.
//
// We never use real UTC instants for event times. A wall-clock string is mapped to
// "milliseconds as if it were UTC" so we can compare and add days without DST or
// timezone surprises. Both sides of any comparison are in the same timezone.

export const DAY_MS = 86_400_000;
export const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

export const pad = (n: number) => String(n).padStart(2, "0");
export const startOfDay = (ms: number) => ms - (ms % DAY_MS);

/** Wall-clock string to fake-UTC ms. NaN if malformed or not a real date (e.g. 30 Feb). */
export function wallToMs(s: string): number {
  const m = LOCAL_RE.exec(s);
  if (!m) return NaN;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
  if (h > 23 || mi > 59 || se > 59) return NaN;
  const ms = Date.UTC(y, mo - 1, d, h, mi, se);
  const back = new Date(ms);
  // Round-trip catches overflow like Feb 30 -> Mar 2.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return NaN;
  return ms;
}

export function msToWall(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19);
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The current wall-clock time in `tz`, as "YYYY-MM-DDTHH:mm:ss". */
export function nowWall(now: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const p: Record<string, string> = {};
  for (const x of parts) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

export function dayLabel(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function clock(ms: number) {
  const d = new Date(ms);
  const h = d.getUTCHours();
  return { text: `${h % 12 || 12}:${pad(d.getUTCMinutes())}`, suffix: h < 12 ? "am" : "pm" };
}
