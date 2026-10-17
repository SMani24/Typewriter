# Memory checks

These checks use temporary notebooks, synthetic words and essays, and no API keys
or external providers. They do not inspect a personal essay or change the real
notebook. Results from 17 October 2026 are saved in
[memory-results.json](memory-results.json).

## What was checked

The backend audit creates 200 words and repeatedly requests the notebook state,
checks a 100,000-character essay, and extracts its spelling flags. Samples follow
garbage collection, after ten warm-up cycles. RSS is the Linux process's resident
memory, read from `/proc/self/status`.

The browser audit opens an isolated headless Chrome instance with 200 words. Each
cycle refreshes the notebook, visits My words and Essay Studio, fills a
26,800-character essay, and opens and closes the flag list. Samples follow an
explicit browser garbage collection. The script records JavaScript heap, DOM
counters, event listeners, and proportional physical memory (PSS) for the processes
reported by Chrome. PSS apportions shared pages; it is different from both the JS
heap and a task manager's per-process RSS.

A second browser driver uses direct CDP with no Playwright or `Network.enable`.
It exercises the app through its own controls and native text insertion. This is
a control for the automation driver, rather than a substitute for the UI tests.
Typing mode adds a space each cycle; replacement mode replaces the whole essay.

The recorded environment is Python 3.10.12 on Linux, with Chrome 155.0.8059.39.
Measurements vary with the browser, libraries, notebook size, and desktop.

## Results and interpretation

| Workload | After warm-up | Middle | End |
| --- | ---: | ---: | ---: |
| Backend RSS, 1,000 cycles | 54.08 MiB | 57.86 MiB | 58.01 MiB |
| Direct Chrome PSS, 320 typing cycles | 302.18 MiB | 312.86 MiB | 298.97 MiB |
| Direct Chrome JS heap, same run | 1.52 MiB | 1.55 MiB | 1.64 MiB |

The backend retained one extraction for an unchanged essay across 3,000 measured
requests. Its final 500 cycles added 0.15 MiB of sampled RSS. Peak RSS is the maximum
of the kernel's high-water reading and the sampled RSS readings.

The direct Chrome run kept 4,932 live elements and 110 event listeners throughout.
Its browser process count varied from ten to eight as Chrome retired processes,
so total PSS includes those process-lifecycle effects. This finite run did not
reproduce sustained application memory growth.

The Playwright measurements are also retained. Before the rendering optimization,
a 320-cycle replacement run increased Chrome PSS from 247.83 to 384.92 MiB while
JS heap changed from 2.80 to 3.03 MiB. Afterward, an 80-cycle typing run kept DOM
counters constant but Chrome PSS still rose from 237.59 to 275.12 MiB; JS heap rose
from 3.22 to 3.32 MiB. The direct control did not repeat that sustained trend.
This points to a difference in the instrumented workload/browser environment;
it does not establish a specific cause or prove that every browser leak is absent.
In particular, the DOM optimization should not be read as a claimed cure for all
native Chrome memory growth.

## Changes from the audit

- Pronunciation download locks now use two fixed pools of 64 locks. Previously the
  dictionaries of locks retained an entry for every recording encountered.
- Spelling checks calculate UTF-16 positions incrementally rather than allocating
  a position array for every essay character.
- Reopening an unchanged essay's flags reuses its saved extraction. Earlier
  extractions remain on disk so outstanding LLM replies and saved flag lists keep
  their provenance; changing an essay can still grow this disk cache.
- Unchanged notebook, dashboard, log, and flag-list markup is reused on refresh.
  A browser regression check confirms an unchanged notebook row retains its DOM
  identity. Previously those regions were rebuilt even when their content stayed
  the same. Updated content and selection changes still render normally.
- Loudness conversion runs one FFmpeg job at a time per app instance. It streams
  source hashing, bounds decoder diagnostics and failed-conversion records, and
  caches processed audio on disk. Originals remain intact.

The offline dictionary is intentionally cached in memory. Downloaded recordings,
preparation provenance, and database backups live on disk. SQLite connections close
after each operation; request bodies and provider responses still require transient
memory while being processed.

## Reproduce

From the repository, after installing the normal Python and browser-test dependencies:

```bash
.venv/bin/python scripts/check_memory.py
.venv/bin/python scripts/check_memory.py --cycles 1000
node scripts/check_browser_memory.cjs
node scripts/check_browser_memory.cjs 80 typing
node scripts/check_browser_memory_direct.cjs 320 typing
```

The scripts print JSON and remove their temporary notebooks. The browser script
defaults to `/opt/google/chrome/chrome`; set `TYPEWRITER_BROWSER_PATH` to another
installed Chromium executable if needed. PSS measurements require Linux `/proc`
access; unavailable process measurements are reported rather than guessed.
Set `TYPEWRITER_MEMORY_PROGRESS=1` for browser samples on stderr during a long run.
The direct driver needs Node 22 or newer for its built-in WebSocket client and
does not load Playwright. Both drivers use a fresh disposable Chrome profile.

These are finite workload measurements, not proof against every leak. They do not
diagnose other tabs, extensions, the user's existing browser session, very large
backup operations, or days of uninterrupted practice. Closing a Typewriter tab
leaves its small local server running; **Stop Typewriter** in the launcher menu
stops that process too.
