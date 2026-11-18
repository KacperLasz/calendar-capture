// Recurrence expansion. Shortcuts has no native repeat option, so the server turns a rule
// into individual dated occurrences. Deterministic code, not the model: the model only
// describes the rule. Everything is wall-clock, so DST is the phone's problem, not ours.
import { CONFIG } from "./config.ts";
import { DAY_MS, dayLabel, startOfDay, wallToMs } from "./dates.ts";

export type Frequency = "none" | "daily" | "weekly" | "monthly" | "yearly";

export interface Recurrence {
  frequency: Frequency;
  interval: number; // every N days/weeks/months/years, 1 or more
  days_of_week: string[]; // weekly only: "MO".."SU". Empty = same weekday as the start
  until: string; // "YYYY-MM-DD" inclusive, or "" for none
  count: number; // total occurrences, or 0 for none
}

export const NO_RECURRENCE: Recurrence = { frequency: "none", interval: 1, days_of_week: [], until: "", count: 0 };

// Index = Date.getUTCDay().
export const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** Same day-of-month `n` months later, or NaN if that day doesn't exist (e.g. 31st in April). */
function addMonthsExact(ms: number, n: number): number {
  const d = new Date(ms);
  const total = d.getUTCMonth() + n;
  const y = d.getUTCFullYear() + Math.floor(total / 12);
  const m = ((total % 12) + 12) % 12;
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  if (d.getUTCDate() > daysInMonth) return NaN; // skip, like iCalendar does
  return Date.UTC(y, m, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
}

const GUARD = 20_000; // belt and braces so a bad rule can never loop forever

function* candidates(start: number, rule: Recurrence): Generator<number> {
  const step = rule.interval;
  if (rule.frequency === "daily") {
    for (let k = 0; k < GUARD; k++) yield start + k * step * DAY_MS;
  } else if (rule.frequency === "weekly") {
    const sd = startOfDay(start);
    const time = start - sd;
    const days = rule.days_of_week.length
      ? rule.days_of_week.map((c) => WEEKDAY_CODES.indexOf(c))
      : [new Date(start).getUTCDay()];
    // Weeks run Monday to Sunday, so "Mon, Wed" and "Sun" order sensibly within a week.
    const offsets = [...new Set(days.map((d) => (d + 6) % 7))].sort((a, b) => a - b);
    const weekStart = sd - ((new Date(sd).getUTCDay() + 6) % 7) * DAY_MS;
    for (let w = 0; w < GUARD; w += step) {
      for (const o of offsets) {
        const c = weekStart + (w * 7 + o) * DAY_MS + time;
        if (c >= start) yield c;
      }
    }
  } else if (rule.frequency === "monthly") {
    for (let k = 0; k < GUARD; k++) {
      const c = addMonthsExact(start, k * step);
      if (!Number.isNaN(c)) yield c;
    }
  } else if (rule.frequency === "yearly") {
    for (let k = 0; k < GUARD; k++) {
      const c = addMonthsExact(start, 12 * k * step);
      if (!Number.isNaN(c)) yield c;
    }
  }
}

export interface Expansion {
  starts: number[];
  /** True when we stopped at CONFIG.maxOccurrences although the rule wanted more. */
  capped: boolean;
}

/** Occurrence start times (fake-UTC ms) for a rule, first one being `start` itself when it matches. */
export function expand(start: number, rule: Recurrence): Expansion {
  if (rule.frequency === "none") return { starts: [start], capped: false };

  const want = rule.count > 0 ? rule.count : Infinity;
  let until = Infinity;
  if (rule.until) {
    until = wallToMs(rule.until + "T23:59:59");
  } else if (rule.count === 0) {
    // Open-ended ("every Monday"): stop at a sensible horizon rather than guessing forever.
    const d = new Date(startOfDay(start));
    until = Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth() + CONFIG.defaultHorizonMonths[rule.frequency],
      d.getUTCDate(),
      23,
      59,
      59,
    );
  }

  const starts: number[] = [];
  let capped = false;
  for (const c of candidates(start, rule)) {
    if (c > until || starts.length >= want) break;
    if (starts.length >= CONFIG.maxOccurrences) {
      capped = true;
      break;
    }
    starts.push(c);
  }
  return { starts, capped };
}

const UNIT = { daily: "day", weekly: "week", monthly: "month", yearly: "year" } as const;
const ADVERB = { daily: "daily", weekly: "weekly", monthly: "monthly", yearly: "yearly" } as const;

/** Human-readable rule for the summary, e.g. "weekly on Mon, Wed, 12 times until Mon 25 Jan". */
export function describeRecurrence(rule: Recurrence, expansion: Expansion): string {
  if (rule.frequency === "none") return "";
  const f = rule.frequency;
  let text = rule.interval === 1 ? ADVERB[f] : `every ${rule.interval} ${UNIT[f]}s`;
  if (f === "weekly" && rule.days_of_week.length) {
    const names = rule.days_of_week.map((c) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][WEEKDAY_CODES.indexOf(c)]);
    text += ` on ${names.join(", ")}`;
  }
  const n = expansion.starts.length;
  const last = expansion.starts[n - 1];
  text += `, ${n} time${n === 1 ? "" : "s"} until ${dayLabel(last)}`;
  if (expansion.capped) text += ` (limited to ${CONFIG.maxOccurrences})`;
  return text;
}
