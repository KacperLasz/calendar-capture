import { assert, assertEquals } from "jsr:@std/assert@1";
import { validateModelOutput } from "../../parse-event/validate.ts";

const NOW = new Date("2026-11-08T12:00:00Z"); // Sun 8 Nov 2026, 12:00 Dublin
const base = { now: NOW, timezone: "Europe/Dublin" };

const reminder = (over: Record<string, unknown> = {}) => ({
  type: "reminder",
  title: "Call the bank",
  start: "2026-11-10T14:00:00",
  end: "2026-11-10T14:00:00",
  all_day: false,
  location: "",
  notes: "",
  recurrence: { frequency: "none", interval: 1, days_of_week: [], until: "", count: 0 },
  ...over,
});
const wrap = (events: unknown[]) => JSON.stringify({ status: "ok", events, question: "", message: "" });

function run(events: unknown[], sourceText?: string) {
  const r = validateModelOutput(wrap(events), { ...base, sourceText });
  assert(r.ok, !r.ok ? r.error : "");
  return r.response;
}

Deno.test("a reminder keeps its type, with end equal to start", () => {
  const r = run([reminder()], "remind me to call the bank Tuesday at 2");
  assertEquals(r.events[0].type, "reminder");
  assertEquals(r.events[0].end, r.events[0].start);
  assertEquals(r.summary, "Reminder: Call the bank, Tue 10 Nov, 2:00pm");
});

Deno.test("a day with no time gets the default reminder time", () => {
  const r = run([reminder({ all_day: true, start: "2026-11-10T00:00:00", end: "2026-11-10T00:00:00" })], "remind me to call the bank Tuesday");
  assertEquals(r.events[0].start, "2026-11-10T09:00:00");
  assertEquals(r.events[0].all_day, false);
});

Deno.test("reminder wording is required: otherwise the model's reminder becomes an event", () => {
  const r = run([reminder()], "call the bank Tuesday at 2");
  assertEquals(r.events[0].type, "event");
  // Gets the default duration instead of failing the "end after start" check.
  assertEquals(r.events[0].end, "2026-11-10T15:00:00");
});

Deno.test("every spelling of the trigger word counts", () => {
  for (const t of ["Remind me to call the bank", "set a reminder for the bank", "REMINDER: bank", "reminders: bank"]) {
    assertEquals(run([reminder()], t).events[0].type, "reminder", t);
  }
});

Deno.test("an event stays an event even when the user says remind", () => {
  const e = { ...reminder(), type: "event", end: "2026-11-10T15:00:00" };
  assertEquals(run([e], "remind me about the dentist").events[0].type, "event");
});

Deno.test("a mixed message can hold an event and a reminder", () => {
  const e = { ...reminder(), type: "event", title: "Gym", end: "2026-11-10T15:00:00" };
  const r = run([e, reminder()], "gym at 2 and remind me to call the bank");
  assertEquals(r.events.map((x) => x.type), ["event", "reminder"]);
});

Deno.test("reminder location moves into the notes", () => {
  const r = run([reminder({ location: "Main Street branch", notes: "Bring ID" })], "remind me to go to the bank");
  assertEquals(r.events[0].location, "");
  assertEquals(r.events[0].notes, "Location: Main Street branch\nBring ID");
});

Deno.test("recurring reminders expand like recurring events", () => {
  const r = run(
    [reminder({ title: "Take vitamins", start: "2026-11-09T08:00:00", end: "2026-11-09T08:00:00", recurrence: { frequency: "daily", interval: 1, days_of_week: [], until: "", count: 3 } })],
    "remind me every day at 8 to take vitamins",
  );
  assertEquals(r.events.length, 3);
  assert(r.events.every((e) => e.type === "reminder" && e.end === e.start));
  assertEquals(r.events[2].start, "2026-11-11T08:00:00");
  assertEquals(r.summary, "Reminder: Take vitamins, Mon 9 Nov, 8:00am - repeats daily, 3 times until Wed 11 Nov");
});

Deno.test("a reminder in the past asks for the date", () => {
  const r = run([reminder({ start: "2026-11-07T14:00:00", end: "2026-11-07T14:00:00" })], "remind me to call the bank yesterday at 2");
  assertEquals(r.status, "needs_clarification");
});

Deno.test("an unknown type is rejected", () => {
  const r = validateModelOutput(wrap([reminder({ type: "task" })]), base);
  assert(!r.ok);
});
