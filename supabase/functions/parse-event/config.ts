// Everything you are likely to want to tweak lives here.

export const CONFIG = {
  // Used when GEMINI_MODEL / DEFAULT_TIMEZONE env vars are not set.
  defaultModel: "gemini-3.5-flash-lite",
  defaultTimezone: "Europe/Dublin",

  // Event defaults (also stated to the model in the system prompt).
  defaultDurationMinutes: 60,

  // Limits.
  maxEvents: 5,
  maxTitleLength: 100,
  maxLocationLength: 200,
  maxNotesLength: 500,
  maxTextLength: 1000,
  // Two 1000-char fields plus JSON overhead is ~2.1 KB, so "about 2 KB" gets a little headroom.
  maxBodyBytes: 2560,

  // Reminders given a day but no time (e.g. "remind me to call Mum tomorrow") get this time.
  reminderDefaultTime: "09:00",

  // Recurrence. Shortcuts can't repeat natively, so each occurrence becomes its own item.
  maxOccurrences: 60, // per recurring item
  maxTotalItems: 100, // across the whole message, to keep the Shortcut loop short
  maxInterval: 52, // "every N weeks" etc.
  // How far an open-ended rule ("every Monday") runs when no end or count is given.
  defaultHorizonMonths: { daily: 3, weekly: 3, monthly: 12, yearly: 60 },

  // A start time further back than this counts as "in the past" and triggers a question.
  pastGraceMinutes: 5,

  // Gemini call behaviour.
  geminiTimeoutMs: 15_000,
  geminiRetryBackoffMs: 800,
  // Note: Google says Gemini 3.6+ models ignore this value. 3.5 Flash-Lite honours it.
  temperature: 0.1,
};

// Personal rules appended verbatim to the system prompt. One plain-English rule per entry.
export const USER_RULES: string[] = [
  // "The dentist is always 1 hour.",
  // "Mum is Maria. Dad is Tom.",
  // "Gym sessions are 90 minutes and the location is 'PureGym Tallaght'.",
  // "If I say 'after work' I mean 6pm.",
];
