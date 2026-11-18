// The only file that talks to Gemini. To change provider, keep the callModel() signature
// and rewrite the body. Nothing here logs prompts or model output.
import { CONFIG } from "./config.ts";

/** `code` is safe to log: it never contains message text. */
export class LlmError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

// REST responseSchema uses the OpenAPI-style uppercase type names (per Google's REST example).
// Optional text fields are plain strings ("" = none) rather than nullable, to stay on the
// simplest part of the schema subset. Length limits are not enforced by Gemini; validate.ts does that.
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    status: { type: "STRING", enum: ["ok", "needs_clarification", "error"] },
    events: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          type: { type: "STRING", enum: ["event", "reminder"] },
          recurrence: {
            type: "OBJECT",
            properties: {
              frequency: { type: "STRING", enum: ["none", "daily", "weekly", "monthly", "yearly"] },
              interval: { type: "INTEGER", description: "Every N days/weeks/months/years. 1 for none." },
              days_of_week: {
                type: "ARRAY",
                items: { type: "STRING", enum: ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] },
                description: "Weekly only. Empty otherwise.",
              },
              until: { type: "STRING", description: "YYYY-MM-DD last allowed date, or empty string" },
              count: { type: "INTEGER", description: "Total occurrences, or 0 for no limit" },
            },
            required: ["frequency", "interval", "days_of_week", "until", "count"],
          },
          title: { type: "STRING" },
          start: { type: "STRING", description: "YYYY-MM-DDTHH:mm:ss local time" },
          end: { type: "STRING", description: "YYYY-MM-DDTHH:mm:ss local time" },
          all_day: { type: "BOOLEAN" },
          location: { type: "STRING" },
          notes: { type: "STRING" },
        },
        required: ["type", "recurrence", "title", "start", "end", "all_day", "location", "notes"],
      },
    },
    question: { type: "STRING" },
    message: { type: "STRING" },
  },
  required: ["status", "events", "question", "message"],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(url: string, apiKey: string, body: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.geminiTimeoutMs);
  try {
    return await fetch(url, {
      method: "POST",
      // Key in a header, not the URL, so it can't end up in logs.
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body,
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new LlmError(err instanceof DOMException && err.name === "AbortError" ? "timeout" : "network");
  } finally {
    clearTimeout(timer);
  }
}

/** Sends the prompt, returns the model's raw JSON text. Throws LlmError on any failure. */
export async function callModel(system: string, user: string): Promise<string> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) throw new LlmError("missing_api_key");
  const model = Deno.env.get("GEMINI_MODEL") || CONFIG.defaultModel;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: {
      temperature: CONFIG.temperature,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  });

  let res = await post(url, apiKey, body);
  // One retry on 5xx only; a timeout or 429 is not worth hammering.
  if (res.status >= 500) {
    await res.body?.cancel();
    await sleep(CONFIG.geminiRetryBackoffMs);
    res = await post(url, apiKey, body);
  }

  if (res.status === 429) {
    await res.body?.cancel();
    throw new LlmError("rate_limit");
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new LlmError(`upstream_${res.status}`);
  }

  const data = await res.json();
  if (data?.promptFeedback?.blockReason) throw new LlmError("blocked");

  const parts: Array<{ text?: string; thought?: boolean }> = data?.candidates?.[0]?.content?.parts ?? [];
  // Skip "thought" parts if the model returns them; we only want the answer.
  const text = parts.filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
  if (!text) throw new LlmError(`empty_${data?.candidates?.[0]?.finishReason ?? "unknown"}`);
  return text;
}
