# Typewriter

A personal spelling notebook with focused typing drills and spaced reviews.
Runs locally in your browser; your words and progress live in SQLite on your computer.

Add words from your writing, practise a difficult spelling repeatedly, and come back
for short reviews. Drill repetitions, hints, and correction attempts are kept separate
from unaided recall. Words become confident after successful reviews across different days.

![Typewriter’s daily practice screen](docs/preview.png)

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

- Add individual words with manual clues, or paste a list of words.
- Look up meanings, exact-word examples, and UK/US audio in Cambridge Dictionary.
- Ask Gemini to fill missing meanings, sentences, and spelling tips in batches.
- Find a drill word in an editable dropdown; matches narrow as you type, with Tab completion.
- Drill for 10, 20, or 50 correct repetitions, or practise without a target.
- Review due words, or select a set for extra practice. Enter checks an answer and advances through feedback.
- Choose active reviews and drills in Settings → Practice modes.
- See recall accuracy, practice activity, and recurring misspellings.
- Export and import words and history from Settings. Repeated imports don't duplicate attempts.

The optional starter collection includes twelve words and needs no API calls.

## Gemini and request limits

Place one API key per line in **`api_keys.txt`**, or paste keys in Settings.
Environment variables `GEMINI_API_KEYS` (comma-separated) and `GEMINI_API_KEY` are also
supported and take precedence over the file. Keys stay on the Python server.

Automatic preparation waits for five pending words by default, then sends up to five
words in each request. Change the batch size, model, daily request budget per key,
and request pacing in Settings. **Prepare now** processes the queue immediately;
select words in My words to prepare just that set. It still respects request budgets.
The default model is `gemini-flash-latest`; you can select a specific Flash version instead.

Results are saved locally. Existing text is preserved, and unsuitable sentences are
rejected. Sources are shown in the word editor; suggestions remain editable.
Failures and partial results remain visible after refreshing or restarting. Failed words
stay queued for a manual retry. Temporary server errors receive up to two retries,
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

## Proxy

In **Settings → Proxy**, enable HTTP or SOCKS5, enter the host and port, and optionally
set a username and password. The editable preset is `127.0.0.1:10808`; a fresh install
starts with the proxy disabled. SOCKS5 uses proxy-side DNS resolution.

All app requests to Gemini and Cambridge, including pronunciation downloads, use this
route. The app never falls back to direct networking when an enabled proxy fails.
Disabling the proxy means a direct connection, regardless of shell proxy variables.
Use **Save & test connection** to check the route; this checks connectivity, not API quotas.

## Local data

Your notebook, settings, request counters, preparation results, the latest 500 log events,
and cached audio are in **`data/`**. Logs live in SQLite alongside the notebook.
API keys, proxy credentials, backups, and personal data are excluded from Git.
Backups contain words and attempts, but no keys or connection settings.
The server binds to localhost and uses same-origin request checks. This is a personal
local app; internet hosting and multi-user accounts are outside its current scope.

Dictionary parsing draws on [AnkiAutomata](https://github.com/SMani24/AnkiAutomata).
Typewriter runs independently of Anki. Dictionary lookups depend on Cambridge's site
structure and availability; manual entry and Gemini remain alternatives.

## Checks

```bash
python -m unittest discover -s tests -v
```

Optional browser checks use a temporary notebook and never call Gemini or Cambridge:

```bash
npm install
npx playwright install chromium
npm test
```

Node is needed only for these browser checks. The app itself runs with Python.
