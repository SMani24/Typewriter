# Typewriter

A personal spelling notebook with focused typing drills and spaced reviews.
Runs locally in your browser; your words and progress live in SQLite on your computer.

Add words from your writing, practise a difficult spelling repeatedly, and come back
for short reviews. Drill repetitions, hints, and correction attempts are kept separate
from unaided recall. Legacy stages grow through due reviews across different UTC days; FSRS is an optional adaptive scheduler.

![Typewriter’s daily practice screen](preview.png)

## Run

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python app.py
```

Open **http://127.0.0.1:8080**. Use `python app.py --port 8081` to change the port.

Python 3.10 or newer is required. On Windows, activate with `.venv\Scripts\activate`.

### Pop!_OS / Linux launcher

After setting up the Python environment, install the application-menu entry:

```bash
python3 desktop/install.py
```

Search for **Typewriter** in your application launcher and open it. It starts the
local server in the background and opens your default browser. Repeated clicks reuse
the running server. If port 8080 is occupied by another app, a nearby free port is used.
No terminal or administrator privileges are needed for normal launching.

Closing the browser tab leaves the server running. The launcher's **Stop Typewriter**
action stops a server it started; you can also run `python3 desktop/launch.py --stop`.
Keep the project folder in place, or rerun the installer after moving it.
Remove `~/.local/share/applications/typewriter.desktop` to remove the menu entry.

## Your notebook

Choose Small, Default, Large, or Extra large in **Settings → Reading & appearance**.
The text size previews immediately; save to keep it or discard to restore your size.

- Add individual words with manual clues, or paste a list of words.
- Look up meanings, exact-word examples, and UK/US audio in Cambridge Dictionary.
- Ask Gemini to fill missing meanings, sentences, and spelling tips in batches.
- Find a drill word in an editable dropdown; matches narrow as you type, with Tab completion.
- Drill for 10, 20, or 50 correct repetitions, or practise without a target.
- Review due words, select a set for extra practice, or choose **Practise endlessly** on Today. Enter checks an answer; a result card stays visible until you press Enter again.
- Choose sentence spelling, spelling from a meaning, audio-only spelling, and meaning quizzes in Settings.
- Choose automatic playback separately for each task in Settings; **Alt+P** replays audio.
- Flag incorrect pronunciation, preview recordings, or upload your own voice in the word editor.
- Flag unclear examples or meanings during practice, or select existing words and prepare them again.
- Edit the current word during a review or drill, including correcting its spelling.
- Adjust playback volume and read the review-ranking explanation in Settings.
- See recall accuracy, practice activity, and recurring misspellings.
- Export and import words and history from Settings. Repeated imports don't duplicate attempts.

The optional starter collection includes twelve words and needs no API calls.

Spelling reviews mix the enabled clue types; an exercise only includes words with the
material it needs. Audio-only exercises show no sentence or definition. Meaning quizzes
ask you to choose a definition (click or press **1–4** to answer immediately) and have separate scores;
they do not advance spelling stages. Repeated word drills remain a separate session.

**Legacy** remains the default spelling scheduler. Its priority uses the last eight
spaced recalls, the latest struggle, and time overdue. A spaced recall is the first
due, unaided answer per word per UTC day since the upgrade; lifetime totals still
include older history and extra practice. Due successes advance through 1, 3, 7, 14,
and 30-day stages at most once per UTC day. Extra successes keep the date unchanged;
misses or hints return in ten minutes. Every fifth displayed normal spelling question
uses the oldest due eligible word, carrying credit across short sessions.

For adaptive dates, open **Settings → Spelling scheduler → Preview switching to FSRS**.
Compare due counts and example dates, then confirm. FSRS uses due spelling answers
with a 90% retention target and short learning steps. Both engines keep separate
progress, so you can return to Legacy after ending a session. Older answers are kept
as history rather than replayed into FSRS. Drills, corrections, early practice, and
meaning quizzes do not train its spelling memory.

The [ranking guide](review-ranking.md) explains selection, evidence, switching,
backup compatibility, and limitations. Meaning quizzes keep their separate ranking
and rhythm in both engines.

Words with at least two misses in their last eight unaided spelling reviews appear
as **Worth a drill** on Today and in the notebook and word picker. Repeated confirmed
essay mistakes can suggest a drill too, while remaining separate from answer scores. Three consecutive
correct unaided reviews clear the suggestion; a new struggle can bring it back.
Hinted answers, corrections, quizzes, and drill repetitions do not establish recall.
Finishing a drill with at least ten correct repetitions and 80% accuracy lowers that
word's **drill priority by 75% for 24 hours**, labelled **Recently drilled**. This also
applies to open-ended drills when you finish. The word stays searchable; its review
schedule and recall score stay unchanged. A missed or hinted spelling review restores
full drill priority immediately. Shorter or less accurate drills still save every
repetition without earning a new reduction.

Reviews include **all due words with material for your enabled exercises** by default.
In Settings, keep **All words ready for review** checked (0), or set **Words per review**
to 1–100 for a shorter session. Existing custom limits are kept; the former default of
10 upgrades to all due words once. Selected reviews use the whole selection.
**Practise endlessly** keeps the same exercises and quiz spacing until you press
**Escape** or End session. It starts with due words, then revisits your notebook as
extra practice, choosing another set using your latest performance. **Endless review**
in the selection bar stays within the selected words. Meaning-only sessions can
continue endlessly too. Each answer is saved immediately; ending shows your totals.
Repeated successes still earn at most one spelling-stage promotion per day.
When no spelling reviews are due, **Start my review** offers endless spelling practice
or meaning quizzes. Choosing only meaning exercises in Settings starts quizzes directly.

In **Settings → Exercises & sessions → Meaning quiz rhythm**, use the sliders for a
fixed interval (five spelling words by default) or a random inclusive range such as
**2–7**. A new random gap is drawn after each quiz. Spacing applies within each review
session, including across word sets in endless mode; quizzes are extra questions
alongside the chosen number of spelling words. Corrections
don't count as another word, and unanswered skips don't count. If meaning quizzes are
the only available exercise, the session contains quizzes throughout.
Press **Enter** after quiz feedback when you're ready to continue.

Choose **UK or US pronunciation** in Settings. Dictionary playback and previews use
that accent unless the word has its own saved accent choice. New words are checked in
the background; if the preferred accent is missing, you can accept an available
alternative for those words. Change a word’s accent in its editor. Uploaded
recordings take precedence. Check a pronunciation in the word editor before including
it in audio-only exercises.

Use **Find another voice** in the word editor or during practice when a recording is
missing or sounds wrong. The popup offers other Cambridge accents, then
[Oxford Learner’s Dictionaries](https://www.oxfordlearnersdictionaries.com/about/english/pronunciation_english),
[Wiktionary](https://en.wiktionary.org/), and the
[Free Dictionary API](https://dictionaryapi.dev/), which can locate additional
Wikimedia Commons recordings. Only exact-word matches are offered. Use the
list to compare every available voice. Each recording has one **Play** button and a
selection control. Listen to as many as you like, select your preferred voice, confirm
it says the word correctly, then choose **Keep selected voice**. You do not need to
reject any voice to hear another. Repeated recordings found through different sources
appear once. **Search again, including previously rejected voices** also restores voices
hidden by earlier versions. Closing the popup leaves your recording unchanged.
New words with missing Cambridge audio prompt you to find alternatives or **Skip for now**,
including words added from essay flags.

An approved alternative applies to this word regardless of the global accent setting,
and is enabled for audio-only practice. Its source, speaker, and available license
information remain visible in the editor. You can remove it there to return to
unchecked Cambridge audio, flag it during practice, or replace it with an upload.
Sources can be unavailable or lack the exact word; manual uploads remain available.
Existing Cambridge recordings start unchecked. Cambridge lookups only offer audio from
an exact matching headword, avoiding recordings for a base word or redirected typo.
**Wrong pronunciation?** excludes a recording; an uploaded MP3, WAV, OGG, or M4A
(up to 5 MB) replaces it and enables listening practice. If the browser blocks automatic
playback, press **Alt+P** or Listen once to grant a playback gesture. Checked recordings
load silently ahead of playback, and replay reuses the loaded clip. Recordings are
privately cached by their revision so an uploaded replacement uses a fresh URL.

In **Settings → Automatic audio playback**, choose automatic playback separately
for sentence spelling, spelling from a meaning, audio-only spelling, meaning quizzes,
word drills, and correction practice. Audio-only playback starts enabled; the other
tasks start disabled. Available, unflagged recordings can play automatically in clue
exercises and drills.
Unchecked recordings remain excluded from audio-only questions. Turning
it off leaves **Listen** and **Alt+P** available. The **Playback volume** slider controls
practice audio and previews, including mute. **Play the word after checking an answer**
works independently of sound when a task opens. With FFmpeg installed, current and
future playback uses disk-cached loudness-adjusted copies; original recordings are kept.
Quiet loading also prepares the next known checked recording. Leading near-silence
is trimmed from the playback copy; recordings can still need a first download through
your proxy. A stalled load shows a retry message after 20 seconds rather than waiting
indefinitely.

**Advanced settings** contains a repeat audio cooldown and the duration of an
audio-only pause, along with API request budgets and pacing. Requests for the same
recording within the cooldown (1.2 seconds from the previous play request by default)
are ignored, whether automatic or **Listen / Alt+P**. Nothing plays later unless you
request it again. Another word can play immediately, and failed playback allows an
immediate retry. During a drill, **Mute automatic audio for this drill** turns off both opening and answer-feedback sound for that
session; manual replay still works, and a new drill uses your saved preferences.

In an audio-only question, **Pause audio-only** temporarily excludes those exercises
without flagging recordings, grading a skip as a mistake, or changing saved exercise
preferences. Other enabled clues remain available. If the current word has no other
enabled clue, the session ends with its checked answers preserved; start another
session for eligible words. The pause survives reload until its timer expires and can
be ended early with **Resume audio-only now**. The default pause is ten minutes.

Settings prompt you to save or discard changes before leaving the page. Changing a
word's spelling restarts its schedule and word-level statistics while preserving
past answers in global history; check its sentence, tip, and pronunciation again.

To repair accent availability in an existing notebook, run
`python desktop/repair_pronunciations.py --apply`. This creates a database backup,
checks Cambridge through your configured proxy, and saves an available alternative
where the preferred accent is missing. It preserves uploads and pronunciation flags,
and writes a private report in `data/`.

## Essay studio

Use the arrow beside the page title to collapse desktop navigation to an icon rail;
the app remembers your choice. This gives the essay page more room.

Open **Essay studio** for a quiet writing space with a title, prompt, word count,
and automatic local saving. Your text stays exactly as typed: autocorrect and
browser spelling services are disabled. Turn **Highlight possible spelling errors**
on or off at any time. Underlines use a bundled offline English wordlist that accepts
British and American spellings; names and uncommon words may still be flagged.
This checks spelling rather than grammar or essay quality, and uses no API quota.

Use **Review flagged words** to merge new possible misspellings above your existing
review list, even when underlines are off. Earlier flags and your corrections stay
until queued or discarded. Queued flags leave the list immediately and stay cleared
when you reopen it or import older suggestions.
Discard unwanted flags with the eraser button, or accept a valid spelling in the personal
dictionary. You can also press **Ctrl+.** at a word in the editor. Personal spellings
are saved locally and can be removed in Settings.

Enter intended spellings and queue words one at a time or all together. The confirmation
popup offers manual preparation or LLM preparation. New queued words appear under
**My words → Needs preparing**, outside practice. For manual preparation, fill a clue
in the word editor and select **Save & add to practice**. LLM preparation can fill the
material through your configured API batches or prompt export/import. Its optional
automatic pronunciation choice remains unchecked until you approve it for audio-only
exercises. A source outage leaves manual pronunciation selection available.

Confirming a misspelling of an existing word records separate essay evidence and brings
that word back for review. Repeated intake of the same flags is idempotent. It does not
invent an incorrect quiz answer or train FSRS from an assisted essay correction. A later
successful unaided spelling review resolves that essay reminder.

For a second opinion, expand **Ask your own LLM to check these flags**. Export the remaining
flags as prompts, optionally including short excerpts. Preview the LLM's JSON/Markdown
reply and use its suggestions in the list before queuing anything. Newer manual edits
are kept; valid spellings can be skipped. The essay text stays unchanged.

Numbered and bulleted lists continue on Enter; Enter on an empty list item stops the
list. **Shift+Enter** keeps the current marker and starts a continuation line;
**Tab** on that blank line starts an indented list (`1.` → `a.` → `-`).
**Enter** continues that marker type. **Shift+Tab** returns an item to its parent
list type and next number. **Tab** also indents text or selected lines, and
**Shift+Tab** outdents. **Escape, then Tab**
lets keyboard users move to the next control. Ordinary text editing and undo remain
available. Extra space below the final line lets you scroll your writing away from
the bottom edge. The editor does not insert formatted HTML.

There is one current draft. **Download draft** saves a text copy before you start
another. The draft is included in notebook backups; import restores it only when
the current draft is empty. Existing essays stay protected. An unsaved copy in the
current browser tab helps recover after a failed save or reload. If another tab has
saved a newer essay, download your version before reloading; recovery offers an
explicit choice instead of silently overwriting the other draft.

The wordlist's provenance and notices are in
[`typewriter/resources/spelling/`](../typewriter/resources/spelling/README.md).

## Gemini and request limits

Place one API key per line in **`api_keys.txt`**, or paste keys in Settings.
Environment variables `GEMINI_API_KEYS` (comma-separated) and `GEMINI_API_KEY` are also
supported and take precedence over the file. Keys stay on the Python server.

Automatic preparation waits for five pending words by default, then sends up to five
words in each request. Change the batch size, model, daily request budget per key,
and request pacing in Settings. **Prepare now** processes the queue immediately;
select words in My words to prepare just that set. It still respects request budgets.
The default model is `gemini-flash-latest`; you can select a specific Flash version instead.
Model IDs use forms such as [`gemini-3.5-flash`](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash).
Common reversed names such as `gemini-flash-3.5` are normalized when saved.
**Refresh model list** loads available text models through your configured connection.
Before generation, the app checks model metadata and caches successful checks per key
for a day. An unavailable model does not consume a local generation-request budget.
Model discovery and validation are metadata requests, not text-generation requests.

Results are saved locally. Ordinary preparation preserves existing text; flagged meanings
can be corrected on an explicit retry. Unsuitable sentences are rejected. Sources are shown in the word editor; suggestions remain editable.
Failures and partial results remain visible after refreshing or restarting. Failed words
stay queued for a manual retry. A failure popup offers **Use another LLM**, switching to
prompt export/import for the unfinished words while preserving your connection settings.
Temporary server errors receive up to two retries,
with backoff and the same request budgets; retries also count as requests.
A generation request waits up to two minutes for a response, allowing slower thinking
models to finish; the batch status stays visible while it runs.
Settings → Application log shows recent results, HTTP statuses, and connection errors.
Download the log when troubleshooting; raw responses and credentials are never logged.

Keys rotate between requests and when a provider limit or rejected key is encountered.
Usage and cooldowns survive restarts. Daily counters reset at midnight Pacific time.
[Gemini quotas apply per Google project](https://ai.google.dev/gemini-api/docs/rate-limits),
so keys from the same project don't provide independent limits. The local request budget
is a configurable ceiling, not a measurement of your provider's remaining token quota.

## Prepare with any LLM, without an API

Choose **Settings → Word preparation → Preparation method → Another LLM** and save.
This disables Gemini generation, including automatic batches. Choose **Add material by
hand** for manual entry instead. Both options work without API keys.

1. Open **Prepare with another LLM** in My words, or the export/import tool in Settings.
2. Choose the queue or selected words and **1–100 words per file**. Download the ZIP.
   To revisit prepared words, select them in My words and choose **Prepare again**, or
   enable **Re-evaluate existing material** in the export dialog.
3. Give one Markdown prompt at a time to your chosen LLM. Each includes instructions,
   vocabulary, a unique batch ID, and the exact JSON output contract.
4. Paste the reply or open its `.json`, `.md`, or `.txt` file. It is checked automatically.
   When it is ready, review the changes and click **Apply to notebook**.
   **Preview reply** checks immediately or retries a failed check.

Validation progress and errors appear beside the reply. Older checks cannot enable
Apply for text you have changed. If a reply has already been imported or its words
were edited after export, those entries stay protected; **Export fresh prompts for
changed words** creates a new re-evaluation batch. A stalled check offers a retry
after ten seconds and keeps your pasted text.

The app also accepts a Markdown reply containing one fenced JSON block. Import validates
all entries before changing anything, rejects unexpected/duplicate words and unsuitable
sentences, and fills empty fields while keeping your edits. Partial replies leave omitted
words queued; repeated imports do not overwrite prepared words. Flagged clue imports
replace only the flagged example and/or meaning, with new quiz options for corrected
meanings, while preserving other saved material. Explicit
re-evaluation replaces meanings, sentences, tips, and quiz options after preview. Replies
exported before a newer edit or flag change are skipped. Keep the same notebook
(database) for export and import: it records which words belong to each batch.

**Unhelpful example?** and **Unclear or wrong meaning?** during practice queue the
respective clue for improvement. The word editor has the same controls. A flagged
example is excluded from sentence questions; a flagged meaning is excluded from
definition clues and meaning quizzes. Flagging the active clue before answering lets
you skip without recording an attempt. The next API preparation batch or exported LLM
prompt asks for a specific meaning and a sentence with enough context to infer the
missing word. Only flagged fields are replaced; other saved material and newer edits
are kept. API batching still follows your preparation method, word threshold, and
limits. You can also edit the clue manually or clear its flag in the editor.

Gemini and exported prompts request three plausible, clearly incorrect meanings matched
to each word's intended sense. Quizzes use these generated options when available; older
words use other unflagged notebook meanings until prepared again. Preview the options
before importing; LLM suggestions still need checking.

The exported prompts contain your chosen vocabulary and clues. They contain no API keys,
proxy settings, or practice history. Export and import make no external requests.

## Proxy

In **Settings → Proxy**, enable HTTP or SOCKS5, enter the host and port, and optionally
set a username and password. The editable preset is `127.0.0.1:10808`; a fresh install
starts with the proxy disabled. SOCKS5 uses proxy-side DNS resolution.

All app requests to Gemini and dictionary sources, including alternative-voice searches,
previews, and pronunciation downloads, use this route. The app never falls back to
direct networking when an enabled proxy fails.
Disabling the proxy means a direct connection, regardless of shell proxy variables.
Use **Save & test connection** to check the route; this checks connectivity, not API quotas.

## Local data

Your notebook, settings, request counters, preparation results, the latest 500 log events,
and cached audio are in **`data/`**. Logs live in SQLite alongside the notebook.
API keys, proxy credentials, backups, and personal data are excluded from Git.
Backups contain words, attempts, pronunciation and clue flags, and generated quiz
options, both spelling schedules, the active scheduler, and the essay draft, but no keys
or connection settings. Personal spelling additions, essay reminders, and preparation queues are included too.
Format-1 and format-2 backups remain importable; a full format-3 restore into
an empty notebook restores the scheduler choice. Merges keep the existing choice.
Upgrades create a physical database backup before migrating older notebooks.
Uploaded recordings are not embedded in JSON backups. Copy the entire `data/` directory
when moving your notebook and its recordings together.
Approved alternative-source choices and attribution are included in JSON backups.
Imported recordings need checking again before audio-only practice; alternative voices
can be downloaded again through your configured proxy.
The server binds to localhost and uses same-origin request checks. This is a personal
local app; internet hosting and multi-user accounts are outside its current scope.

Dictionary parsing draws on [AnkiAutomata](https://github.com/SMani24/AnkiAutomata).
Typewriter runs independently of Anki. Dictionary lookups and alternative voices depend
on each source’s site structure and availability; manual entry and recordings remain available.

## Checks

```bash
python -m unittest discover -s tests -v
```

Optional browser checks use a temporary notebook and never call Gemini or external
dictionary sources:

```bash
npm install
npx playwright install chromium
npm test
```

Node is needed only for these browser checks. The app itself runs with Python.


## Troubleshooting an unexpected failure

**Settings → Application log → Download log** includes curated events and diagnostic
references. Browser failures include script locations. Unexpected server and process
failures include exception types and stack locations, without exception messages,
source-code excerpts, request bodies, keys, or notebook contents. Diagnostic files in
`data/` rotate at 256 KiB with two older files retained. Browser reports are rate-limited.
The launcher keeps earlier startup output and rotates it on a later launch once it
passes 512 KiB.

If the app stops responding, note the steps and approximate time, then download the
log after reopening it. A forcibly killed process cannot record its own termination;
a missing exception record does not prove that no process-level failure happened.
For duplicate spellings, the add-word dialog now offers to edit the saved word;
existing material is kept until you explicitly save changes. Bulk entry can add only
the new spellings.

The [typing-confidence proposal](typing-confidence.md) discusses possible future
use of response timing and self-correction. It is not implemented.
