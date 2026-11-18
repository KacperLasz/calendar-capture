// Pure functions only: no network, no Deno APIs, `now` is always passed in so tests are deterministic.
import { CONFIG } from "./config.ts";
import { clock, DAY_MS, dayLabel, msToWall, nowWall, startOfDay, wallToMs } from "./dates.ts";
import { describeRecurrence, expand, NO_RECURRENCE, type Recurrence, WEEKDAY_CODES } from "./recur.ts";

// Tests and the handler import these from here.
export { dayLabel, isValidTimezone, msToWall, nowWall, wallToMs } from "./dates.ts";

export interface CalEvent {
  /** "reminder" goes to the Reminders app, "event" to Calendar. `start` is the due time for a reminder. */
  type: "event" | "reminder";
  title: string;
  start: string; // local wall-clock "YYYY-MM-DDTHH:mm:ss", no offset
  end: string; // equals start for reminders
  all_day: boolean;
  location: string;
  notes: string;
}

export interface ApiResponse {
  status: "ok" | "needs_clarification" | "error";
  /** Recurring items are already expanded into one entry per occurrence. */
  events: CalEvent[];
  question: string | null;
  summary: string;
  message: string;
}

export type Validation =
  | { ok: true; response: ApiResponse }
  | { ok: false; error: string };

export interface ValidateContext {
  now: Date;
  timezone: string;
  /** The user's raw words. If given, a "reminder" is only accepted when they contain "remind". */
  sourceText?: string;
}

// Words that mean "this repeats". Deliberately broad: a false positive only lets the model's
// own judgement through, while a false negative would silently drop a real recurrence.
const REPEAT_WORDS = new RegExp(
  "\\b(every|each|daily|weekly|monthly|yearly|annual|annually|fortnightly|weekdays?|weekends?|" +
    "(mon|tues?|wednes|thurs?|fri|satur|sun)days|per (day|week|month|year)|once a (day|week|month|year))\\b",
  "i",
);

// ---------- Formatting (summary is built here, never by the model) ----------

function summariseEvent(e: CalEvent): string {
  const s = wallToMs(e.start);
  const en = wallToMs(e.end);
  if (e.type === "reminder") {
    const c = clock(s);
    return `Reminder: ${e.title}, ${dayLabel(s)}, ${c.text}${c.suffix}`;
  }
  if (e.all_day) {
    const last = en - DAY_MS; // end is exclusive (next day 00:00)
    return last > s
      ? `${e.title}, ${dayLabel(s)} - ${dayLabel(last)} (all day)`
      : `${e.title}, ${dayLabel(s)} (all day)`;
  }
  const a = clock(s);
  const b = clock(en);
  if (startOfDay(s) === startOfDay(en)) {
    // "3:00-4:00pm" when both share am/pm, otherwise "11:30am-12:30pm".
    const range = a.suffix === b.suffix
      ? `${a.text}-${b.text}${b.suffix}`
      : `${a.text}${a.suffix}-${b.text}${b.suffix}`;
    return `${e.title}, ${dayLabel(s)}, ${range}`;
  }
  return `${e.title}, ${dayLabel(s)} ${a.text}${a.suffix} - ${dayLabel(en)} ${b.text}${b.suffix}`;
}

export function formatSummary(events: CalEvent[]): string {
  return events.map(summariseEvent).join("\n");
}

// ---------- Validation ----------

class Fail extends Error {}
const fail = (msg: string): never => {
  throw new Fail(msg);
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Optional text field: missing/null becomes "", wrong type is an error. */
function optText(v: unknown, name: string): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") return fail(`${name} must be a string`);
  return v.trim();
}

function checkRecurrence(v: unknown, startMs: number, i: number): Recurrence {
  if (v === undefined || v === null) return NO_RECURRENCE;
  if (!isObj(v)) return fail(`events[${i}].recurrence must be an object`);
  const f = v.frequency;
  if (f === undefined || f === "none") return NO_RECURRENCE;
  if (f !== "daily" && f !== "weekly" && f !== "monthly" && f !== "yearly") {
    return fail(`events[${i}].recurrence.frequency must be none, daily, weekly, monthly or yearly`);
  }

  const interval = v.interval === undefined ? 1 : v.interval;
  if (!Number.isInteger(interval) || (interval as number) < 1 || (interval as number) > CONFIG.maxInterval) {
    return fail(`events[${i}].recurrence.interval must be a whole number from 1 to ${CONFIG.maxInterval}`);
  }

  let days: string[] = [];
  if (v.days_of_week !== undefined && v.days_of_week !== null) {
    if (!Array.isArray(v.days_of_week) || !v.days_of_week.every((d) => WEEKDAY_CODES.includes(d as string))) {
      return fail(`events[${i}].recurrence.days_of_week must only contain MO, TU, WE, TH, FR, SA, SU`);
    }
    // Only meaningful for weekly; ignoring it elsewhere avoids a pointless retry.
    if (f === "weekly") days = v.days_of_week as string[];
  }

  const until = optText(v.until, "recurrence.until");
  if (until) {
    const u = wallToMs(until + "T00:00:00");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || Number.isNaN(u)) {
      return fail(`events[${i}].recurrence.until must be a real date as YYYY-MM-DD, or ""`);
    }
    if (u < startOfDay(startMs)) return fail(`events[${i}].recurrence.until is before the first occurrence`);
  }

  const count = v.count === undefined || v.count === null ? 0 : v.count;
  if (!Number.isInteger(count) || (count as number) < 0) {
    return fail(`events[${i}].recurrence.count must be a whole number, 0 for none`);
  }

  return { frequency: f, interval: interval as number, days_of_week: days, until, count: count as number };
}

interface Definition {
  event: CalEvent;
  rule: Recurrence;
}

function checkEvent(raw: unknown, i: number, ctx: ValidateContext): Definition {
  if (!isObj(raw)) return fail(`events[${i}] must be an object`);

  if (typeof raw.title !== "string") return fail(`events[${i}].title must be a string`);
  const title = raw.title.trim();
  if (!title) return fail(`events[${i}].title is empty`);
  if (title.length > CONFIG.maxTitleLength) {
    return fail(`events[${i}].title is longer than ${CONFIG.maxTitleLength} characters`);
  }

  const rawType = raw.type === undefined ? "event" : raw.type;
  if (rawType !== "event" && rawType !== "reminder") {
    return fail(`events[${i}].type must be "event" or "reminder"`);
  }
  let type: "event" | "reminder" = rawType;
  // Reminders are opt-in by wording. If the user never said "remind", don't trust the model.
  const downgraded = type === "reminder" && ctx.sourceText !== undefined && !/remind/i.test(ctx.sourceText);
  if (downgraded) type = "event";

  if (typeof raw.all_day !== "boolean") return fail(`events[${i}].all_day must be a boolean`);
  if (typeof raw.start !== "string" || typeof raw.end !== "string") {
    return fail(`events[${i}].start and .end must be strings`);
  }
  let s = wallToMs(raw.start);
  let e = wallToMs(raw.end);
  if (Number.isNaN(s)) return fail(`events[${i}].start must be a real date as YYYY-MM-DDTHH:mm:ss`);
  if (Number.isNaN(e)) return fail(`events[${i}].end must be a real date as YYYY-MM-DDTHH:mm:ss`);

  let allDay = raw.all_day;
  let location = optText(raw.location, "location").slice(0, CONFIG.maxLocationLength);
  let notes = optText(raw.notes, "notes").slice(0, CONFIG.maxNotesLength);

  if (type === "reminder") {
    // A day with no time becomes a reminder at the default time, so it fires at a sensible hour.
    if (allDay) {
      const [h, m] = CONFIG.reminderDefaultTime.split(":").map(Number);
      s = startOfDay(s) + (h * 60 + m) * 60_000;
    }
    e = s;
    allDay = false;
    // Reminders have no location field in the Shortcut, so keep it visible in the notes.
    if (location) notes = `Location: ${location}${notes ? `\n${notes}` : ""}`;
    location = "";
  } else if (allDay) {
    // Normalise rather than reject: midnight to midnight, end at least one day after start.
    s = startOfDay(s);
    e = startOfDay(e);
    if (e <= s) e = s + DAY_MS;
  } else if (e <= s) {
    // A reminder has end == start, so a downgraded one needs the default duration, not a retry.
    if (!downgraded) return fail(`events[${i}].end must be after start`);
    e = s + CONFIG.defaultDurationMinutes * 60_000;
  }

  // Same idea as reminders: models love to make birthdays repeat. No repeat word, no recurrence.
  const mayRepeat = ctx.sourceText === undefined || REPEAT_WORDS.test(ctx.sourceText);
  const rule = mayRepeat ? checkRecurrence(raw.recurrence, s, i) : NO_RECURRENCE;
  return {
    event: { type, title, start: msToWall(s), end: msToWall(e), all_day: allDay, location, notes },
    rule,
  };
}

function build(
  status: ApiResponse["status"],
  extra: Partial<ApiResponse> = {},
): ApiResponse {
  return { status, events: [], question: null, summary: "", message: "", ...extra };
}

/**
 * Strictly parse and check the model's JSON, expand recurrences, then apply the past-date rule.
 * `ok: false` means "retry the model"; `ok: true` is a final response (including
 * needs_clarification and error outcomes, which are valid answers).
 */
export function validateModelOutput(raw: string, ctx: ValidateContext): Validation {
  try {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return fail("Output was not valid JSON");
    }
    if (!isObj(data)) return fail("Output must be a JSON object");

    const question = optText(data.question, "question");
    const message = optText(data.message, "message");

    if (data.status === "needs_clarification") {
      if (!question) return fail("needs_clarification requires a non-empty question");
      return { ok: true, response: build("needs_clarification", { question: question.slice(0, 300) }) };
    }

    if (data.status === "error") {
      if (!message) return fail("error status requires a non-empty message");
      return { ok: true, response: build("error", { message: message.slice(0, 300) }) };
    }

    if (data.status !== "ok") return fail('status must be "ok", "needs_clarification" or "error"');

    if (!Array.isArray(data.events) || data.events.length === 0) {
      return fail("status ok requires at least one event");
    }
    if (data.events.length > CONFIG.maxEvents) {
      return fail(`at most ${CONFIG.maxEvents} events are allowed`);
    }
    const defs = data.events.map((r, i) => checkEvent(r, i, ctx));

    // Expand recurrences into one entry per occurrence.
    const nowMs = wallToMs(nowWall(ctx.now, ctx.timezone));
    const events: CalEvent[] = [];
    const lines: string[] = [];
    for (const { event, rule } of defs) {
      const startMs = wallToMs(event.start);
      const duration = wallToMs(event.end) - startMs;
      const ex = expand(startMs, rule);
      const first = ex.starts[0];

      // Past check lives in code because the model can't be trusted to notice it.
      // An all-day event today is fine, so compare it to the start of today.
      const cutoff = event.all_day ? startOfDay(nowMs) : nowMs - CONFIG.pastGraceMinutes * 60_000;
      if (first < cutoff) {
        return {
          ok: true,
          response: build("needs_clarification", {
            question: `"${event.title}" would be ${dayLabel(first)}, which has already passed. What date did you mean?`,
          }),
        };
      }

      const occurrences = ex.starts.map((c) => ({ ...event, start: msToWall(c), end: msToWall(c + duration) }));
      events.push(...occurrences);
      const note = rule.frequency === "none" ? "" : ` - repeats ${describeRecurrence(rule, ex)}`;
      lines.push(summariseEvent(occurrences[0]) + note);
    }

    if (events.length > CONFIG.maxTotalItems) {
      return {
        ok: true,
        response: build("error", {
          message: `That would create ${events.length} items, and the limit is ${CONFIG.maxTotalItems}. Try a shorter period.`,
        }),
      };
    }

    return { ok: true, response: build("ok", { events, summary: lines.join("\n") }) };
  } catch (err) {
    if (err instanceof Fail) return { ok: false, error: err.message };
    throw err; // a real bug: let the handler's catch-all report it
  }
}
