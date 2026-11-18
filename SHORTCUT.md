# Building the iOS Shortcut

You need the deployed function URL and your `SHORTCUT_SECRET` (see [README.md](README.md)). Open the Shortcuts app, tap **+**, and name it e.g. **Quick Event**. Add the actions below in order. Exact wording of the actions can differ slightly between iOS versions.

Tip: where an action needs a value from an earlier step, tap the field, tap the **variable** button (or the earlier action's result) and pick it. Tap **Show More** on each action to reveal all its options.

## 1. Ask for the message

1. **Ask for Input**
   - Input Type: **Text**
   - Prompt: `What's the event?`
   - Leave **Default Answer** empty.
   - Nothing to set up for dictation. When you run the Shortcut, a text box and keyboard appear; tap the microphone key at the bottom-right of the keyboard and speak. (If there's no microphone key: Settings → General → Keyboard → **Enable Dictation**.)

## 2. Send it to the function

2. **Get Contents of URL**
   - URL: `https://YOUR_PROJECT_REF.supabase.co/functions/v1/parse-event`
   - Tap **Show More**
   - Method: **POST**
   - Headers: add `x-shortcut-secret` = your secret (the Content-Type header is added automatically for a JSON body)
   - Request Body: **JSON**, then **Add new field**: type **Text**, key `text`, value = **Provided Input** (the result of Ask for Input)
3. **Get Dictionary from Input** (input: Contents of URL)

The Shortcut doesn't send a timezone, so the server uses its default (`Europe/Dublin`). To send one anyway, add a second Text field `timezone` with an IANA name.

## 3. Branch on status

4. **Get Dictionary Value**: Get **Value** for key `status` in *Dictionary*
5. **Get Text from Input** (input: the *Dictionary Value*). iOS only offers an **is** comparison on text, not on a raw Dictionary Value, so this conversion is needed.
6. **If** *Text* **is** `needs_clarification`

### A. `needs_clarification`: one question, one retry

Inside that If:

   1. **Get Dictionary Value** for key `question` in *Dictionary*
   2. **Ask for Input** (Text), prompt = the *question* value (tap the prompt field and insert the variable)
   3. **Get Contents of URL**: same as step 2 above, with two JSON fields:
      - `text` = *Provided Input* from the question you just asked (the answer)
      - `previous_text` = the original message. Easiest: add **Set Variable** `original` right after step 1 and use `original` here.
   4. **Get Dictionary from Input** (input: that Contents of URL)

Only one clarification round is built in. If the answer is still unclear, the function replies with status `error` and says what is missing.

To keep the rest of the Shortcut simple, finish this branch with **Set Variable** `result` = the new *Dictionary* from sub-step 4. In the **Otherwise** branch (no clarification needed), add **Set Variable** `result` = *Dictionary* from step 3. Then **End If**. From here on, use `result`.

### B. Read the final status

6. **Get Dictionary Value** key `status` in `result`, then **Get Text from Input** (same reason as above)
7. **If** *Text* **is** `error`
   - **Get Dictionary Value** key `message` in `result`
   - **Show Alert**: title `Couldn't add event`, message = *message*, turn off **Show Cancel Button**
8. **Otherwise**, **If** the status **is** `ok`:

(If the status is `needs_clarification` even after the second call, the function won't normally do that; treat it like `error` and show `question`.)

### C. `ok`: confirm and add

9. **Get Dictionary Value** key `summary` in `result`
10. **Show Alert**: title `Add to calendar?`, message = *summary*, Show Cancel Button **on**. Cancelling stops the Shortcut.
11. **Get Dictionary Value** key `events` in `result`
12. **Repeat with Each** (input: *events*), and inside the loop:
    1. **Get Dictionary Value** key `title` in *Repeat Item* → **Set Variable** `title`
    2. **Get Dictionary Value** key `start` in *Repeat Item* → **Get Dates from Input** → **Set Variable** `startDate`
    3. **Get Dictionary Value** key `end` in *Repeat Item* → **Get Dates from Input** → **Set Variable** `endDate`
    4. **Get Dictionary Value** key `all_day` in *Repeat Item* → **Set Variable** `allDay`
    5. **Get Dictionary Value** key `location` → **Set Variable** `location`
    6. **Get Dictionary Value** key `notes` → **Set Variable** `notes`
    7. **Get Dictionary Value** key `type` in *Repeat Item*, then **If** it **is** `reminder`:
       - **Add New Reminder**: Title = `title`, **Due Date** = `startDate` (use Show More to reveal it), Notes = `notes`, List = the one you want. Ignore `endDate`, `allDay` and `location` for reminders; the server already folded the location into the notes.
       - **Otherwise**, **Add New Event**:
         - Title = `title`
         - Start Date = `startDate`, End Date = `endDate`
         - **All Day** = `allDay` (tap the toggle and pick the variable; the value is true or false)
         - Location = `location`, Notes = `notes`
         - Calendar: pick the one you want
       - **End If**
13. **End Repeat**. Then, still inside the `ok` branch, **Count** the *events* (Count: Items), and **Show Notification**: `Added ` followed by the count followed by ` item(s)`. Doing this once, outside the loop, matters because a recurring item can create dozens of entries and you don't want a notification for each.
14. **End If** for both the `ok` and `error` branches.

### Reminders and recurring items

- **Reminders** go into the **Reminders** app, not Calendar. They appear in the Calendar app too if you turn on the Reminders calendar there. The server only produces one when your message uses the word "remind" or "reminder" ("remind me to...", "set a reminder for..."). Anything else is a Calendar event.
- A reminder given a day but no time (for example "remind me to call Mum Thursday") is set for 9:00am. Change `reminderDefaultTime` in `config.ts` if you prefer another time.
- **Recurring** events and reminders ("every Monday at 7pm", "remind me every day at 8am to take vitamins for 5 days") come back already expanded into one `events` entry per date, so the loop above handles them with no extra steps. Apple's Shortcuts has no native repeat option for these actions, so each occurrence is a separate calendar entry or reminder, and editing the series later means editing each one.
- With no end given ("every Monday"), the server stops after 3 months (daily and weekly), 12 months (monthly) or 5 years (yearly), and never creates more than 60 per item or 100 per message. The confirmation alert tells you how many and until when, so you can cancel before anything is added.

For an all-day event, `start` is midnight on the day and `end` is midnight on the next day. Apple Calendar treats that as a single all-day event, so no adjustment is needed.

## 4. Test

Run the Shortcut from inside the Shortcuts app and try:

- `dentist tuesday half two` should show the confirmation, then add the event
- `dinner tonight` should ask what time, then add it after you answer
- `remind me to call the bank tomorrow at 2` should show "Reminder: Call the bank..." and land in Reminders
- `yoga every Monday at 7pm for 4 weeks` should list the pattern in the confirmation, then add 4 events

If you get a 401-style error, the secret header is wrong. If the dictionary values come back empty, check that the field keys are spelled exactly as above (`text`, `previous_text`, `x-shortcut-secret`).

## 5. Ways to run it

- **Action Button** (iPhone 15 Pro and later): Settings → Action Button → **Shortcut** → pick Quick Event.
- **Back Tap**: Settings → Accessibility → Touch → **Back Tap** → Double or Triple Tap → pick Quick Event under Shortcuts.
- **Widget**: long-press the Home Screen → **+** → **Shortcuts** → add it, then choose Quick Event. It also works as a Lock Screen widget.
- **Siri**: say "Hey Siri, Quick Event".

## Speaking instead of typing

Swap **Ask for Input** for **Dictate Text** (Show More: pick your language, and **Stop Listening: After Pause** for hands-free use). Its output is **Dictated Text**, so re-select that wherever the old **Provided Input** chip was used (the `text` field, `original`, `previous_text`). For the clarification question, add **Speak Text** with the `question` value before a second **Dictate Text**, so the Shortcut asks aloud. Then start it with "Hey Siri, Quick Event", the Action Button or Back Tap. Always read the confirmation alert before tapping OK, since a misheard word makes a wrong event.

## If something doesn't work: lessons from building this

- **Chips can silently go blank.** Variable chips and "Dictionary Value" chips sometimes resolve to nothing, giving errors like "no title was provided", "invalid startDate", or the server replying "not a calendar request" (it received an empty `text`). Fix by deleting the chip and re-selecting it from **Select Variable**, or by pointing the field straight at the action output that produced the value.
- **Each "If Text is ..." must use the Text from the Get Text action directly above it.** Your Shortcut has several Text outputs, and picking an earlier one makes the If never match (for example reminders silently become events).
- **Inside the loop, every Get Dictionary Value must read "in Repeat Item".** The default "Dictionary Value" is only the previous lookup, not the event.
- **Add a Show Result** after any step you doubt. It shows exactly what a step produced, and costs nothing to delete afterwards.
- **A "Couldn't add event" alert** means the server answered with status `error`. Put the `message` value in the alert body to see why.

## Timezone note

The function returns times as local wall-clock time (no offset), and **Get Dates from Input** interprets them in **the phone's current timezone**. If the phone is in a different timezone from the one the server assumed (default Europe/Dublin), the event time will be wrong. When travelling, either send `timezone` matching where you are or change `DEFAULT_TIMEZONE`.
