import { assert, assertEquals } from "jsr:@std/assert@1";
import { CONFIG } from "../../parse-event/config.ts";
import { expand, NO_RECURRENCE, type Recurrence } from "../../parse-event/recur.ts";
import { msToWall, validateModelOutput, wallToMs } from "../../parse-event/validate.ts";

// Sunday 8 Nov 2026, 12:00 in Dublin.
const NOW = new Date("2026-11-08T12:00:00Z");
const ctx = { now: NOW, timezone: "Europe/Dublin" };

const rule = (over: Partial<Recurrence>): Recurrence => ({ ...NO_RECURRENCE, ...over });
const dates = (start: string, r: Recurrence) => expand(wallToMs(start), r).starts.map((m) => msToWall(m).slice(0, 10));

// ---------- expand() ----------

Deno.test("no recurrence gives just the start", () => {
  assertEquals(dates("2026-11-10T15:00:00", NO_RECURRENCE), ["2026-11-10"]);
});

Deno.test("daily with a count", () => {
  assertEquals(dates("2026-11-09T09:00:00", rule({ frequency: "daily", count: 3 })), [
    "2026-11-09",
    "2026-11-10",
    "2026-11-11",
  ]);
});

Deno.test("every other day", () => {
  assertEquals(dates("2026-11-09T09:00:00", rule({ frequency: "daily", interval: 2, count: 3 })), [
    "2026-11-09",
    "2026-11-11",
    "2026-11-13",
  ]);
});

Deno.test("weekly defaults to the start's weekday", () => {
  // 9 Nov 2026 is a Monday.
  assertEquals(dates("2026-11-09T19:00:00", rule({ frequency: "weekly", count: 3 })), [
    "2026-11-09",
    "2026-11-16",
    "2026-11-23",
  ]);
});

Deno.test("weekly on several days stays in order and never goes before the start", () => {
  // Start on Wednesday 11 Nov: Monday of that week must be skipped.
  assertEquals(
    dates("2026-11-11T08:00:00", rule({ frequency: "weekly", days_of_week: ["MO", "WE", "FR"], count: 5 })),
    ["2026-11-11", "2026-11-13", "2026-11-16", "2026-11-18", "2026-11-20"],
  );
});

Deno.test("weekdays pattern with Sunday sorted into the right week", () => {
  // Start Fri 13 Nov; SU belongs to the end of the Mon-Sun week.
  assertEquals(
    dates("2026-11-13T08:00:00", rule({ frequency: "weekly", days_of_week: ["SU", "FR"], count: 4 })),
    ["2026-11-13", "2026-11-15", "2026-11-20", "2026-11-22"],
  );
});

Deno.test("every other week", () => {
  assertEquals(dates("2026-11-09T09:00:00", rule({ frequency: "weekly", interval: 2, count: 3 })), [
    "2026-11-09",
    "2026-11-23",
    "2026-12-07",
  ]);
});

Deno.test("monthly skips months that lack the day", () => {
  assertEquals(dates("2026-01-31T09:00:00", rule({ frequency: "monthly", count: 4 })), [
    "2026-01-31",
    "2026-03-31",
    "2026-05-31",
    "2026-07-31",
  ]);
});

Deno.test("yearly keeps the date, and Feb 29 only lands on leap years", () => {
  assertEquals(dates("2026-11-14T00:00:00", rule({ frequency: "yearly", count: 3 })), [
    "2026-11-14",
    "2027-11-14",
    "2028-11-14",
  ]);
  assertEquals(dates("2028-02-29T00:00:00", rule({ frequency: "yearly", count: 2 })), ["2028-02-29", "2032-02-29"]);
});

Deno.test("until is inclusive", () => {
  assertEquals(dates("2026-11-09T09:00:00", rule({ frequency: "weekly", until: "2026-11-23" })), [
    "2026-11-09",
    "2026-11-16",
    "2026-11-23",
  ]);
});

Deno.test("count wins when it comes first, until wins when it comes first", () => {
  assertEquals(dates("2026-11-09T09:00:00", rule({ frequency: "daily", count: 2, until: "2026-12-31" })).length, 2);
  assertEquals(dates("2026-11-09T09:00:00", rule({ frequency: "daily", count: 10, until: "2026-11-10" })).length, 2);
});

Deno.test("open-ended weekly uses the default horizon", () => {
  const r = expand(wallToMs("2026-11-09T19:00:00"), rule({ frequency: "weekly" }));
  assertEquals(r.capped, false);
  // 3 months of Mondays from 9 Nov: 9 Nov ... 8 Feb, inclusive of 8 Feb = 14.
  assertEquals(r.starts.length, 14);
});

Deno.test("open-ended daily is capped at the maximum and flagged", () => {
  const r = expand(wallToMs("2026-11-09T09:00:00"), rule({ frequency: "daily" }));
  assertEquals(r.starts.length, CONFIG.maxOccurrences);
  assert(r.capped);
});

Deno.test("time of day is preserved on every occurrence", () => {
  const starts = expand(wallToMs("2026-11-09T19:30:00"), rule({ frequency: "weekly", count: 3 })).starts;
  assert(starts.every((m) => msToWall(m).endsWith("T19:30:00")));
});

// ---------- Through the validator ----------

const item = (over: Record<string, unknown> = {}) => ({
  type: "event",
  title: "Yoga",
  start: "2026-11-09T19:00:00",
  end: "2026-11-09T20:00:00",
  all_day: false,
  location: "",
  notes: "",
  recurrence: { frequency: "weekly", interval: 1, days_of_week: ["MO"], until: "", count: 3 },
  ...over,
});
const wrap = (events: unknown[]) => JSON.stringify({ status: "ok", events, question: "", message: "" });

Deno.test("recurring event expands, keeps duration, and the summary says so", () => {
  const r = validateModelOutput(wrap([item()]), ctx);
  assert(r.ok && r.response.status === "ok");
  assertEquals(r.response.events.map((e) => e.start.slice(0, 10)), ["2026-11-09", "2026-11-16", "2026-11-23"]);
  assertEquals(r.response.events[2].end, "2026-11-23T20:00:00");
  assertEquals(r.response.summary, "Yoga, Mon 9 Nov, 7:00-8:00pm - repeats weekly on Mon, 3 times until Mon 23 Nov");
});

Deno.test("recurring all-day events keep the exclusive next-day end", () => {
  const r = validateModelOutput(
    wrap([item({ title: "Mum's birthday", all_day: true, start: "2026-11-14T00:00:00", end: "2026-11-15T00:00:00", recurrence: { frequency: "yearly", interval: 1, days_of_week: [], until: "", count: 2 } })]),
    ctx,
  );
  assert(r.ok && r.response.status === "ok");
  assertEquals(r.response.events[1].start, "2027-11-14T00:00:00");
  assertEquals(r.response.events[1].end, "2027-11-15T00:00:00");
});

Deno.test("invalid recurrence is rejected so the model can retry", () => {
  const bad = (recurrence: unknown) => {
    const r = validateModelOutput(wrap([item({ recurrence })]), ctx);
    assert(!r.ok, JSON.stringify(recurrence));
  };
  bad({ frequency: "hourly" });
  bad({ frequency: "weekly", interval: 0 });
  bad({ frequency: "weekly", interval: 1.5 });
  bad({ frequency: "weekly", interval: 999 });
  bad({ frequency: "weekly", days_of_week: ["XX"] });
  bad({ frequency: "weekly", until: "next march" });
  bad({ frequency: "weekly", until: "2026-02-30" });
  bad({ frequency: "weekly", until: "2026-11-01" }); // before the first occurrence
  bad({ frequency: "weekly", count: -1 });
});

Deno.test("days_of_week is ignored for non-weekly rules", () => {
  const r = validateModelOutput(wrap([item({ recurrence: { frequency: "daily", interval: 1, days_of_week: ["MO"], until: "", count: 2 } })]), ctx);
  assert(r.ok && r.response.status === "ok");
  assertEquals(r.response.events.length, 2);
});

Deno.test("too many total items is a friendly error, not a retry", () => {
  const big = item({ recurrence: { frequency: "daily", interval: 1, days_of_week: [], until: "", count: 0 } });
  const r = validateModelOutput(wrap([big, big]), ctx); // 60 + 60 > 100
  assert(r.ok);
  assertEquals(r.response.status, "error");
  assert(r.response.message.includes("limit"));
});

Deno.test("recurrence is dropped unless the user used a repeat word", () => {
  const yearly = { frequency: "yearly", interval: 1, days_of_week: [], until: "", count: 5 };
  const birthday = item({ title: "Mum's birthday", all_day: true, start: "2026-11-14T00:00:00", end: "2026-11-15T00:00:00", recurrence: yearly });
  const once = validateModelOutput(wrap([birthday]), { ...ctx, sourceText: "Mum's birthday on the 14th" });
  assert(once.ok && once.response.status === "ok");
  assertEquals(once.response.events.length, 1);
  assertEquals(once.response.summary, "Mum's birthday, Sat 14 Nov (all day)");

  for (const t of ["birthday every 14th Nov", "yoga Mondays", "bins weekly", "gym each Tuesday", "standup every weekday", "pills once a day"]) {
    const r = validateModelOutput(wrap([birthday]), { ...ctx, sourceText: t });
    assert(r.ok && r.response.events.length === 5, t);
  }
});

Deno.test("past check applies to the first occurrence of a recurring item", () => {
  const r = validateModelOutput(wrap([item({ start: "2026-11-02T19:00:00", end: "2026-11-02T20:00:00" })]), ctx);
  assert(r.ok);
  assertEquals(r.response.status, "needs_clarification");
});
