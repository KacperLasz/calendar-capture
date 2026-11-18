// Sends each sample in samples.json to the locally served function and prints the result.
// Run: deno task try        (needs `supabase functions serve` running and a real Gemini key)
// The results depend on today's date, so "expect" is a sanity check, not a strict test.

const URL = Deno.env.get("FUNCTION_URL") ?? "http://localhost:54321/functions/v1/parse-event";

/** Secret comes from the environment, or from the same .env the local server reads. */
function loadSecret(): string {
  const fromEnv = Deno.env.get("SHORTCUT_SECRET");
  if (fromEnv) return fromEnv;
  try {
    const file = Deno.readTextFileSync("supabase/functions/.env");
    const line = file.split(/\r?\n/).find((l) => l.startsWith("SHORTCUT_SECRET="));
    if (line) return line.slice("SHORTCUT_SECRET=".length).trim();
  } catch { /* fall through */ }
  console.error("Set SHORTCUT_SECRET or create supabase/functions/.env");
  Deno.exit(1);
}

interface Sample {
  text: string;
  expect: { status: string; events?: number; all_day?: boolean; type?: "event" | "reminder" };
}

const secret = loadSecret();
// Optional filter: `deno task try yoga` runs only samples containing "yoga".
const filter = Deno.args[0]?.toLowerCase();
const samples: Sample[] = (JSON.parse(Deno.readTextFileSync("scripts/samples.json")) as Sample[])
  .filter((s) => !filter || s.text.toLowerCase().includes(filter));
let mismatches = 0;

// The Gemini free tier limits requests per minute, so go gently and wait out a 429.
const PAUSE_MS = Number(Deno.env.get("PAUSE_MS") ?? 6000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function send(text: string) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shortcut-secret": secret },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (attempt === 0 && data.message?.startsWith("Rate limit")) {
      console.log("  (rate limited, waiting 65 s and retrying once)");
      await sleep(65_000);
      continue;
    }
    return { res, data };
  }
}

for (const [i, s] of samples.entries()) {
  if (i > 0) await sleep(PAUSE_MS);
  const started = Date.now();
  const { res, data } = await send(s.text);
  const ms = Date.now() - started;

  const problems: string[] = [];
  if (data.status !== s.expect.status) problems.push(`status ${data.status}, expected ${s.expect.status}`);
  if (s.expect.events !== undefined && data.events?.length !== s.expect.events) {
    problems.push(`${data.events?.length} events, expected ${s.expect.events}`);
  }
  if (s.expect.all_day !== undefined && !data.events?.every((e: { all_day: boolean }) => e.all_day === s.expect.all_day)) {
    problems.push(`all_day should be ${s.expect.all_day}`);
  }
  if (s.expect.type !== undefined && !data.events?.every((e: { type: string }) => e.type === s.expect.type)) {
    problems.push(`type should be ${s.expect.type}`);
  }
  if (problems.length) mismatches++;

  console.log(`\n${problems.length ? "CHECK" : "OK   "} "${s.text}"  (HTTP ${res.status}, ${ms} ms)`);
  if (data.summary) console.log(`  summary:  ${data.summary.replaceAll("\n", "\n            ")}`);
  if (data.question) console.log(`  question: ${data.question}`);
  if (data.message) console.log(`  message:  ${data.message}`);
  // Recurring messages can expand to dozens of items, so only show the first few.
  const evs = data.events ?? [];
  for (const e of evs.slice(0, 3)) console.log(`  ${e.type}:    ${JSON.stringify(e)}`);
  if (evs.length > 3) console.log(`  ... ${evs.length} items in total`);
  for (const p of problems) console.log(`  !! ${p}`);
}

console.log(`\n${samples.length - mismatches}/${samples.length} matched expectations`);
