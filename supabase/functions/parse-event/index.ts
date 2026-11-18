import { CONFIG } from "./config.ts";
import { callModel, LlmError } from "./llm.ts";
import { buildRetryNote, buildSystemPrompt, buildUserContent } from "./prompt.ts";
import { type ApiResponse, isValidTimezone, validateModelOutput } from "./validate.ts";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function reply(body: ApiResponse, httpStatus = 200): Response {
  return new Response(JSON.stringify(body), { status: httpStatus, headers: JSON_HEADERS });
}

const errorBody = (message: string): ApiResponse => ({
  status: "error",
  events: [],
  question: null,
  summary: "",
  message,
});

/** Messages for failures of the model call. Handled outcomes, so HTTP 200. */
function llmMessage(code: string): string {
  if (code === "rate_limit") return "Rate limit hit, try again in a minute.";
  if (code === "timeout") return "The AI service took too long to answer. Please try again.";
  if (code === "blocked") return "The AI service couldn't process that message.";
  return "The AI service had a problem. Please try again shortly.";
}

/**
 * Constant-time secret check. Hashing both sides first gives equal-length inputs,
 * so neither the comparison nor the length leaks timing information.
 */
async function secretMatches(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function handle(req: Request, log: { status: string; code?: string }): Promise<Response> {
  if (req.method !== "POST") {
    log.code = "method";
    return reply(errorBody("Use POST."), 405);
  }

  // Deployed with JWT verification off, so this secret is the only protection.
  const expected = Deno.env.get("SHORTCUT_SECRET");
  if (!expected) {
    log.code = "missing_shortcut_secret";
    return reply(errorBody("Server is not configured."), 500);
  }
  if (!(await secretMatches(req.headers.get("x-shortcut-secret") ?? "", expected))) {
    log.code = "unauthorised";
    return reply(errorBody("Unauthorised."), 401);
  }

  // Check the declared size first, then the real size (the header can lie or be absent).
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > CONFIG.maxBodyBytes) {
    log.code = "too_large";
    return reply(errorBody("Request too large."), 413);
  }
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > CONFIG.maxBodyBytes) {
    log.code = "too_large";
    return reply(errorBody("Request too large."), 413);
  }

  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    body = parsed;
  } catch {
    log.code = "bad_json";
    return reply(errorBody("Body must be a JSON object."), 400);
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text || text.length > CONFIG.maxTextLength) {
    log.code = "bad_text";
    return reply(errorBody(`"text" must be 1 to ${CONFIG.maxTextLength} characters.`), 400);
  }
  const previous = body.previous_text;
  if (previous !== undefined && (typeof previous !== "string" || previous.length > CONFIG.maxTextLength)) {
    log.code = "bad_previous_text";
    return reply(errorBody(`"previous_text" must be a string of up to ${CONFIG.maxTextLength} characters.`), 400);
  }
  const tzIn = body.timezone;
  if (tzIn !== undefined && (typeof tzIn !== "string" || !isValidTimezone(tzIn))) {
    log.code = "bad_timezone";
    return reply(errorBody('"timezone" must be a valid IANA timezone, e.g. Europe/Dublin.'), 400);
  }
  const timezone = (tzIn as string | undefined) ||
    Deno.env.get("DEFAULT_TIMEZONE") || CONFIG.defaultTimezone;
  if (!isValidTimezone(timezone)) {
    log.code = "bad_default_timezone";
    return reply(errorBody("Server timezone is misconfigured."), 500);
  }

  // `now` is computed fresh on every request and injected into the prompt.
  const now = new Date();
  const system = buildSystemPrompt(now, timezone);
  const user = buildUserContent(text, (previous as string | undefined)?.trim() || undefined);

  try {
    let retryNote = "";
    // Two attempts: the second one tells the model what was wrong with the first.
    for (let attempt = 0; attempt < 2; attempt++) {
      const output = await callModel(system, user + retryNote);
      // sourceText lets the validator enforce "reminder only if the user said remind".
      const result = validateModelOutput(output, { now, timezone, sourceText: `${previous ?? ""} ${text}` });
      if (result.ok) {
        log.status = result.response.status;
        return reply(result.response);
      }
      log.code = "invalid_output";
      retryNote = buildRetryNote(result.error, output);
    }
    log.status = "error";
    return reply(errorBody("Sorry, I couldn't understand that. Try rephrasing it."));
  } catch (err) {
    if (err instanceof LlmError) {
      log.status = "error";
      log.code = err.code;
      // A missing API key is our misconfiguration, not a handled outcome.
      if (err.code === "missing_api_key") return reply(errorBody("Server is not configured."), 500);
      return reply(errorBody(llmMessage(err.code)));
    }
    throw err;
  }
}

Deno.serve(async (req) => {
  const started = Date.now();
  const log: { status: string; code?: string } = { status: "n/a" };
  let res: Response;
  try {
    res = await handle(req, log);
  } catch {
    log.status = "error";
    log.code = "crash";
    res = reply(errorBody("Unexpected error."), 500);
  }
  // Status, latency and error code only: never message text or model output.
  console.log(JSON.stringify({ http: res.status, status: log.status, code: log.code, ms: Date.now() - started }));
  return res;
});
