import { assert, assertEquals } from "jsr:@std/assert@1";
import { formatSummary, nowWall, validateModelOutput, wallToMs } from "../../parse-event/validate.ts";

// Sunday 8 Nov 2026, 12:00 in Dublin (GMT in winter, so same as UTC).
const NOW = new Date("2026-11-08T12:00:00Z");
const ctx = { now: NOW, timezone: "Europe/Dublin" };

const ev = (over: Record<string, unknown> = {}) => ({
  title: "Dentist",
  start: "2026-11-10T15:00:00",
  end: "2026-11-10T16:00:00",
  all_day: false,
  location: "",
  notes: "",
  ...over,
});
const ok = (events: unknown[]) => JSON.stringify({ status: "ok", events, question: "", message: "" });

function mustPass(raw: string) {
  const r = validateModelOutput(raw, ctx);
  assert(r.ok, `expected ok, got: ${!r.ok && r.error}`);
  return r.response;
}
function mustFail(raw: string, contains?: string) {
  const r = validateModelOutput(raw, ctx);
  assert(!r.ok, "expected a validation failure");
  if (contains) assert(r.error.includes(contains), `"${r.error}" should include "${contains}"`);
}

Deno.test("valid timed event builds the summary in code", () => {
  const r = mustPass(ok([ev()]));
  assertEquals(r.status, "ok");
  assertEquals(r.summary, "Dentist, Tue 10 Nov, 3:00-4:00pm");
});

Deno.test("title is trimmed", () => {
  assertEquals(mustPass(ok([ev({ title: "  Dentist  " })])).events[0].title, "Dentist");
});

Deno.test("all-day event is normalised to midnight with an exclusive end", () => {
  const r = mustPass(ok([ev({ title: "Mum's birthday", all_day: true, start: "2026-11-14T09:00:00", end: "2026-11-14T10:00:00" })]));
  assertEquals(r.events[0].start, "2026-11-14T00:00:00");
  assertEquals(r.events[0].end, "2026-11-15T00:00:00");
  assertEquals(r.summary, "Mum's birthday, Sat 14 Nov (all day)");
});

Deno.test("multi-day all-day summary shows the last day, not the exclusive end", () => {
  const r = mustPass(ok([ev({ title: "Holiday", all_day: true, start: "2026-11-16T00:00:00", end: "2026-11-21T00:00:00" })]));
  assertEquals(r.summary, "Holiday, Mon 16 Nov - Fri 20 Nov (all day)");
});

Deno.test("summary handles am to pm and multiple events", () => {
  const s = formatSummary([
    { type: "event", title: "A", start: "2026-11-10T11:30:00", end: "2026-11-10T12:30:00", all_day: false, location: "", notes: "" },
    { type: "event", title: "B", start: "2026-11-10T18:00:00", end: "2026-11-10T19:00:00", all_day: false, location: "", notes: "" },
  ]);
  assertEquals(s, "A, Tue 10 Nov, 11:30am-12:30pm\nB, Tue 10 Nov, 6:00-7:00pm");
});

Deno.test("summary handles events that cross midnight", () => {
  const s = formatSummary([{ type: "event", title: "Party", start: "2026-11-13T22:00:00", end: "2026-11-14T01:00:00", all_day: false, location: "", notes: "" }]);
  assertEquals(s, "Party, Fri 13 Nov 10:00pm - Sat 14 Nov 1:00am");
});

Deno.test("needs_clarification passes through with no events", () => {
  const r = mustPass(JSON.stringify({ status: "needs_clarification", events: [ev()], question: "What time?", message: "" }));
  assertEquals(r.status, "needs_clarification");
  assertEquals(r.question, "What time?");
  assertEquals(r.events, []);
});

Deno.test("needs_clarification without a question is rejected", () => {
  mustFail(JSON.stringify({ status: "needs_clarification", events: [], question: "", message: "" }), "question");
});

Deno.test("error status passes through, and needs a message", () => {
  const r = mustPass(JSON.stringify({ status: "error", events: [], question: "", message: "Recurring events aren't supported yet." }));
  assertEquals(r.status, "error");
  assertEquals(r.message, "Recurring events aren't supported yet.");
  mustFail(JSON.stringify({ status: "error", events: [], question: "", message: "" }), "message");
});

Deno.test("invalid JSON and wrong shapes are rejected", () => {
  mustFail("not json", "JSON");
  mustFail("[]", "object");
  mustFail(JSON.stringify({ status: "maybe" }), "status");
  mustFail(ok([ev({ all_day: "no" })]), "all_day");
  mustFail(ok([ev({ start: 123 })]), "strings");
  mustFail(ok([ev({ start: "2026-11-10 15:00" })]), "start");
});

Deno.test("impossible dates are rejected", () => {
  mustFail(ok([ev({ start: "2026-02-30T10:00:00", end: "2026-03-01T10:00:00" })]), "start");
});

Deno.test("title must be non-empty and at most 100 characters", () => {
  mustFail(ok([ev({ title: "   " })]), "empty");
  mustFail(ok([ev({ title: "x".repeat(101) })]), "longer");
  mustPass(ok([ev({ title: "x".repeat(100) })]));
});

Deno.test("end must be after start", () => {
  mustFail(ok([ev({ end: "2026-11-10T15:00:00" })]), "after");
  mustFail(ok([ev({ end: "2026-11-10T14:00:00" })]), "after");
});

Deno.test("ok needs 1 to 5 events", () => {
  mustFail(ok([]), "at least one");
  mustPass(ok(Array.from({ length: 5 }, () => ev())));
  mustFail(ok(Array.from({ length: 6 }, () => ev())), "at most");
});

Deno.test("notes and location are capped, not rejected", () => {
  const r = mustPass(ok([ev({ notes: "n".repeat(900), location: "l".repeat(900) })]));
  assertEquals(r.events[0].notes.length, 500);
  assertEquals(r.events[0].location.length, 200);
});

Deno.test("a start more than 5 minutes ago becomes a clarification", () => {
  const r = mustPass(ok([ev({ title: "Doctor", start: "2026-11-07T15:00:00", end: "2026-11-07T16:00:00" })]));
  assertEquals(r.status, "needs_clarification");
  assertEquals(r.events, []);
  assert(r.question!.includes("Sat 7 Nov"));
});

Deno.test("past grace window: 4 minutes ago passes, 6 minutes ago does not", () => {
  assertEquals(mustPass(ok([ev({ start: "2026-11-08T11:56:00", end: "2026-11-08T12:30:00" })])).status, "ok");
  assertEquals(mustPass(ok([ev({ start: "2026-11-08T11:54:00", end: "2026-11-08T12:30:00" })])).status, "needs_clarification");
});

Deno.test("an all-day event today is not in the past, yesterday is", () => {
  const day = (d: string, e: string) => ok([ev({ all_day: true, start: `${d}T00:00:00`, end: `${e}T00:00:00` })]);
  assertEquals(mustPass(day("2026-11-08", "2026-11-09")).status, "ok");
  assertEquals(mustPass(day("2026-11-07", "2026-11-08")).status, "needs_clarification");
});

Deno.test("past check uses the request timezone, not UTC", () => {
  // 23:30 UTC on 8 Nov is already 10:30 on 9 Nov in Sydney (UTC+11).
  const late = { now: new Date("2026-11-08T23:30:00Z"), timezone: "Australia/Sydney" };
  const r = validateModelOutput(ok([ev({ start: "2026-11-09T09:00:00", end: "2026-11-09T10:00:00" })]), late);
  assert(r.ok && r.response.status === "needs_clarification");
});

Deno.test("nowWall converts to the target timezone, including DST", () => {
  assertEquals(nowWall(new Date("2026-07-01T12:00:00Z"), "Europe/Dublin"), "2026-07-01T13:00:00");
  assertEquals(nowWall(new Date("2026-11-08T12:00:00Z"), "Europe/Dublin"), "2026-11-08T12:00:00");
  assertEquals(nowWall(new Date("2026-11-08T00:05:00Z"), "Europe/Dublin"), "2026-11-08T00:05:00");
});

Deno.test("wallToMs rejects malformed input", () => {
  assert(Number.isNaN(wallToMs("2026-13-01T00:00:00")));
  assert(Number.isNaN(wallToMs("2026-11-08T24:00:00")));
  assert(Number.isNaN(wallToMs("2026-11-08")));
});
