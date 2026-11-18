# calendar-capture

Send a short message ("dentist Tuesday at 3") from an iOS Shortcut to a Supabase Edge Function. The function asks Google Gemini to turn it into structured events and returns JSON. The Shortcut then adds the events to Apple Calendar. Build the Shortcut with [SHORTCUT.md](SHORTCUT.md).

```
iPhone Shortcut ──POST──> Edge Function parse-event ──> Gemini (generateContent)
                <──JSON──  (validate, retry once, build summary in code)
```

## Files

| File | Purpose |
| --- | --- |
| `supabase/functions/parse-event/index.ts` | Request handler: auth, size limits, retry loop, response |
| `.../llm.ts` | The only file that talks to Gemini (`callModel()`) |
| `.../prompt.ts` | Builds the system prompt, with current date, time and timezone injected every call |
| `.../validate.ts` | Pure validation, normalisation, reminder rules and summary building |
| `.../recur.ts` | Expands a recurrence rule into dated occurrences |
| `.../dates.ts` | Shared wall-clock date helpers |
| `.../config.ts` | Your settings and the `USER_RULES` list |
| `supabase/functions/tests/` | Unit tests for `validate.ts` |
| `scripts/try.ts`, `scripts/samples.json` | Send sample messages to the local server |

## Prerequisites

- [Supabase CLI](https://supabase.com/docs/guides/cli) and a Supabase project (free tier is fine)
- [Deno](https://deno.com/) (for running the function locally, the tests and `scripts/try.ts`)
- [Docker](https://www.docker.com/) (optional; only for `supabase functions serve`)
- A Gemini API key from <https://aistudio.google.com/apikey>

## Local setup

1. Create the local env file (it is git-ignored) and fill in both values:
   ```bash
   cp .env.example supabase/functions/.env
   ```
   Generate a secret with `openssl rand -hex 32`, or any long random string.
2. Run the function with Deno (no Docker needed). It listens on `http://localhost:8000`:
   ```bash
   deno run --allow-net --allow-env --env-file=supabase/functions/.env supabase/functions/parse-event/index.ts
   ```
   To use another port, set `DENO_SERVE_ADDRESS=tcp:127.0.0.1:8001` first.
   With Docker you can instead use Supabase's own runtime: `supabase start`, then
   `supabase functions serve parse-event --env-file supabase/functions/.env --no-verify-jwt`
   (URL `http://localhost:54321/functions/v1/parse-event`).
3. In another terminal, try the samples (this calls the live Gemini API):
   ```bash
   $env:FUNCTION_URL="http://localhost:8000"; deno task try
   ```

Unit tests need no network or key:

```bash
deno task test
```

## Try it with curl

```bash
curl -s http://localhost:8000 \
  -H "content-type: application/json" \
  -H "x-shortcut-secret: YOUR_SECRET" \
  -d '{"text":"dentist tuesday half two"}'
```

Response:

```json
{
  "status": "ok",
  "events": [{ "type": "event", "title": "Dentist", "start": "2026-11-10T14:30:00", "end": "2026-11-10T15:30:00", "all_day": false, "location": "", "notes": "" }],
  "question": null,
  "summary": "Dentist, Tue 10 Nov, 2:30-3:30pm",
  "message": ""
}
```

`status` is `ok`, `needs_clarification` (answer in `question`; call again with `previous_text` set to the original message and `text` set to the answer) or `error` (see `message`). Times are local wall-clock in the request timezone, with no offset. HTTP 200 is used for every handled outcome; 401, 400, 413 and 5xx are only for bad auth, malformed requests and crashes.

Optional request field `timezone` (an IANA name such as `Europe/London`) overrides the server default.

## Deploy

You do this part yourself. Nothing in this repo links or deploys anything.

```bash
supabase link --project-ref YOUR_PROJECT_REF
supabase secrets set --env-file supabase/functions/.env
supabase functions deploy parse-event --no-verify-jwt
```

Your function URL is `https://YOUR_PROJECT_REF.supabase.co/functions/v1/parse-event`.

### Security: JWT verification is off

The Shortcut can't send a Supabase JWT, so the function is deployed with `--no-verify-jwt` (also set in `supabase/config.toml`). **The `x-shortcut-secret` header is therefore the only thing protecting the endpoint.** Anyone with the URL and secret can spend your Gemini quota. Use a long random secret, keep it out of git, and rotate it with `supabase secrets set SHORTCUT_SECRET=...` (and update the Shortcut) if it leaks. Requests without it get 401.

Other safeguards: body capped at about 2.5 KB, `text` capped at 1000 characters, and message text and model output are never logged (only HTTP status, outcome, error code and latency).

## Configuration

| Setting | Where | Default |
| --- | --- | --- |
| `GEMINI_API_KEY` | secret (required) | none |
| `SHORTCUT_SECRET` | secret (required) | none |
| `GEMINI_MODEL` | secret (optional) | `gemini-3.5-flash-lite` |
| `DEFAULT_TIMEZONE` | secret (optional) | `Europe/Dublin` |
| Durations, limits, timeout, `USER_RULES` | `config.ts` | see file |

Add personal rules to `USER_RULES` in `config.ts` (one sentence each, for example "The dentist is always 1 hour."), then redeploy.

## Swapping the model or provider

- **Different Gemini model:** `supabase secrets set GEMINI_MODEL=gemini-3.8-flash`. No redeploy needed. Note that Google says Gemini 3.6 and newer models ignore `temperature`, so on those the strict validation and one retry do the work of keeping output consistent. Check [the model list](https://ai.google.dev/gemini-api/docs/models) now and then, because older models get retired.
- **Different provider:** rewrite the body of `callModel(system, user)` in `llm.ts`. It must return the model's raw JSON text matching the shape in `RESPONSE_SCHEMA`, and throw `LlmError` with a code like `rate_limit` or `timeout` on failure. Nothing else needs to change.
- **API choice:** `llm.ts` uses Gemini's `generateContent` endpoint. Google now recommends its newer Interactions API for new work but states that `generateContent` remains fully supported.

## Notes

- **Reminders:** a message is a reminder only if it contains "remind" or "reminder" ("remind me to...", "set a reminder for..."); otherwise it is a calendar event. This is enforced in code (`validate.ts`), not left to the model. Each item in `events` has `type: "event"` or `"reminder"`. A reminder's `end` equals its `start`, and a reminder with a day but no time gets `reminderDefaultTime` (09:00, in `config.ts`). Reminders go to the Reminders app.
- **Recurring events and reminders:** "every Monday at 7pm", "every other Wednesday", "every weekday", "monthly", "every year", with an optional end ("for 4 weeks", "10 times", "until 20 Dec"). Apple's Shortcuts can't repeat natively, so the server expands the rule into one `events` entry per occurrence and the Shortcut's existing loop adds them. The model only describes the rule (`recurrence`); the dates are computed in `recur.ts`. Recurrence is only honoured when the message contains a repeat word (every, each, daily, weekly, Mondays, ...), so "Mum's birthday on the 14th" stays a single event.
  - Open-ended rules stop after 3 months (daily, weekly), 12 months (monthly) or 5 years (yearly). Change `defaultHorizonMonths` in `config.ts`.
  - Limits: 60 occurrences per item and 100 items per message (`maxOccurrences`, `maxTotalItems`). Past the 100-item limit the response is `status: "error"`.
  - Not supported: "first Monday of the month", "twice a day", "every 3rd Thursday". The response is an `error` suggesting a simpler pattern. Monthly rules on the 29th to 31st skip months that lack the day.
  - The `summary` describes the pattern, for example `Yoga, Mon 9 Nov, 7:00-8:00pm - repeats weekly on Mon, 4 times until Mon 30 Nov`.
- Gemini's free tier has rate limits that change over time. Check your limits in AI Studio. At a few requests a day you should be nowhere near them.
