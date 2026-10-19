# Typing behavior and spelling: Phase 1

Phase 1 collects optional local measurements. It does not estimate confidence,
classify motor slips, change correctness, change due dates, or alter Legacy / FSRS.
Collection starts **off**, including for existing notebooks. Enable it in Settings
→ Typing measurements, save, and start a new review session.

## Research and interpretation

[Wilschut et al. (2021)](https://www.frontiersin.org/journals/artificial-intelligence/articles/10.3389/frai.2021.780131/full)
measured typed response latency from question presentation to first keypress in a
vocabulary translation task. Their adaptive-learning results motivate an experiment;
they do not validate Typewriter's spelling measurements, correction counts, or a new
IELTS scheduler. Their response modality and study design also differ from this app.

[Feldman, Dale and van Rij (2019)](https://www.frontiersin.org/journals/communication/articles/10.3389/fcomm.2019.00017/full)
found lexical, frequency, and morphological effects on initial and subsequent typing
timings even when participants copied visible words. Timing therefore contains
linguistic information alongside task and motor effects. Smooth typing is not proof
of independent recall, and a pause is not proof of uncertainty.

The working hypothesis remains untested here: do these measurements improve prediction
of a later unaided spelling answer beyond accuracy, history, and spacing? A slow correct
answer stays correct. An immediately repaired slip is not automatically weak knowledge.

## What the repository already did

- `static/app.js` presents sentence, definition, and audio spelling questions, meaning
  quizzes, correction practice, and deliberate repeated-word drills. The latter three
  do not independently test spelling retrieval. Revealed spelling and viewing a word's
  editor or pronunciation picker can also expose the answer.
- Existing `elapsed_ms` starts at `renderPractice()` using `Date.now()` and ends when
  an answer is submitted. It includes reading, loading, listening, and time away.
  Retries can extend that duration. It is stored with the answer and passed as FSRS
  review-duration metadata; it does not determine the rating. Historical values cannot
  be separated into retrieval and execution after the fact. Phase 1 leaves them intact.
- Attempts already retain answer text, correctness, hint/mode/exercise context,
  session kind, UTC creation time, due-before, active engine, and spaced-evidence
  metadata. Word statistics distinguish drills, meaning scores, assisted answers,
  extra practice, and qualified spaced recall. No typing data existed to backfill.
- Legacy protects extra successful practice from postponing due reviews. FSRS uses
  the pinned 6.3.2 adapter, retention 0.9, no fuzzing, and separate versioned state.
  Sessions freeze settings and engine; switching retains progress/history. Neither
  scheduler reads the new table, and their selection/configuration is unchanged.
- Server session rows expire and are pruned. Persisting only their current identifier
  would not support later session-grouped evaluation; retaining their live tokens
  would also be unnecessary. Summaries instead contain a one-way session group hash.

## Initial measurements and exclusions

Collection is restricted to the first presentation of each word in a consenting
review session, for sentence, definition, or audio spelling. Normal, selected, and
endless sessions are distinguished in the existing attempt. Same-day or not-yet-due
practice is not promoted to spaced evidence. Within-session repetitions are excluded.
Drills, corrections, meaning quizzes, hints, and unfinished questions have no summary.
Opening the word editor or pronunciation chooser discards the current measurement.
A re-render cannot create fresh independent evidence for a word already exposed.

Only `#answer` has input/composition/edit listeners, and only during collection.
Temporary state contains counts, lengths, a few clocks, a five-bin histogram, and
flags. It contains no draft string, key names, key codes, copied text, or event
transcript. Reading the field to check non-whitespace input is transient; existing
answer storage is unchanged. No request is sent on individual input events.

| Field | Meaning and limits |
| --- | --- |
| `initial_latency_ms`, `latency_basis` | First meaningful input after presentation, or after audio completes. Text latency includes reading and carries `reading_prompt`; it is not isolated retrieval time. Audio loading/listening is excluded. Missing readiness or interruption before first input yields null / `unavailable`. |
| `typing_span_ms` | First-to-last meaningful edit span; excludes the later wait before submission. |
| `active_typing_ms` | Sum of consecutive edit-event gaps below 2 seconds, excluding gaps crossing focus/visibility loss or audio loading/playback. Not a measurement of motor execution alone. |
| `pause_bins`, `max_pause_ms`, `idle_gap_ms` | Five fixed bins: below 250, 250–499, 500–999, 1000–1999, and at least 2000 ms. Long gaps are recorded separately from active time. Thresholds are instrumentation conventions, not validated cognitive boundaries. |
| `input_events`, `revision_events` | Semantic input events and deletion/replacement/undo events, not physical keypress counts or spelling mistakes. Selection deletion and replacement are handled; undo/composition have flags. |
| `inserted_units`, `deleted_units` | Counts of UTF-16 input units from selection and length changes, never their content. Some IME/history replacements are ambiguous; flags must be considered. |
| `excluded_ms`, `focus_loss_count`, `hidden_count` | Union of blocked time; overlapping audio, window, field-focus, and hidden intervals are not double-counted. Focus notifications may describe the same interruption more than once. |
| `audio_plays`, `audio_duration_ms` | Accepted playback requests and last completed clip duration when available; no audio URLs or recordings are added. Replays, interrupted playback, and typing during audio are flagged. |
| `flags` | Reading, focus/visibility changes, long idle, paste, drop, composition, replacement/autocomplete, history edits, bulk/unknown/untrusted input, audio issues, and input before presentation readiness. No automatic certainty label. |

The browser uses `performance.now()` for differences. A frame callback marks text
presentation readiness; it is not calibrated physical display onset. Listeners start
before playback, so its loading interval is accounted for. An unusually early input
has unavailable latency and `presentation_pending`. Browser throttling, event batching,
screen readers, dictation, remote desktops, and hardware can still affect timings.

Input method is a user-provided coarse label (unspecified, physical keyboard, touch,
or other), frozen for the session. It is not hardware fingerprinting or keyboard-layout
detection. Different layouts, devices, accessibility tools, fatigue, and familiarity
cannot be inferred reliably here. Do not compare raw speeds across them as mastery.

Position-specific summaries are postponed. Aligning edited prefixes and suffixes to
an eventual answer without retaining drafts requires careful validation. Fixed numeric
positions can shift after an insertion; a tempting double-letter interpretation could
be wrong. Establish usefulness of whole-attempt measurements first.

## Persistence, consent, and compatibility

`attempt_typing` is an additive table: `attempt_id` (primary/foreign key, cascading
with attempt deletion), measurement `version`, and a validated JSON `summary`.
The whitelist includes only the fields above plus server-generated `session_group`,
`target_length`, saved-source `prompt_length`, `word_version`, and the frozen `input_method` label.
The existing attempt provides correctness, exercise, history, engine, and timestamps.
Do not persist a session bearer token. Bounded summary JSON is normally under 2 KB;
there are no event arrays. A collector stops after 10,000 edit events or excessive
edit volume, and question duration is bounded to a day. The per-session seen-word
set is capped at 10,000 entries.

Before adding the table to an existing database, Typewriter creates a private SQLite
backup. Existing tables/columns and schema version 3 remain compatible; an older app
can ignore this additive table. A new notebook needs no historical migration. No
historical metrics are invented, and existing scheduler state is not recomputed.

A summary is saved in the same transaction as its attempt, at most once per word per
session group. Both current consent and session-start consent must be on. Invalid,
missing, ineligible, or unsupported summaries are ignored while normal grading continues.
Idempotent retries keep the first submitted summary; a client freezes it before its
first request, so network delays cannot extend it. This is cooperative local browser
data, not tamper-proof evidence. Validation bounds values; it cannot prove cognition.

Optional `typing` objects accompany attempts in normal format-3 notebook backups.
Current import restores valid summaries with remapped attempt IDs, drops invalid/future
measurement versions, and accepts backups without them. Import does not enable
collection. Existing merge rules protect words/history already in the notebook.
Older readers can restore core records but omit these new optional summaries when
re-exporting; do not rely on an old app to archive experimental metadata.

Turning collection off stops future storage and discards the current in-memory
measurement in that window when settings are saved. The server also checks current
consent for an older tab or delayed request. Delete saved typing summaries removes
only this table's rows and turns collection off atomically. Words, answers, schedules,
and essay data remain. Existing backup files must be managed separately. Summaries
stay local unless the user shares a notebook backup; no provider receives them.

## Phases and acceptance criteria

| Phase | Deliverable and gate |
| --- | --- |
| 1 — implemented | Opt-in aggregate collection; absent data is normal. Deterministic timing/edit tests; browser focus, IME, paste, audio, hint, retry and abandonment tests; settings/delete and old/new backup tests; migration preservation. Identical answer/history/due/card state with collection on/off under both engines. No scores, trends, pattern diagnosis, or scheduling changes. |
| 2 — future | An offline analysis against later unaided spelling, with a predeclared target and chronological evaluation. Exported summaries provide a foundation, not a validated model. Report insufficient evidence when follow-up data is sparse. |
| 3 — future | Only after replicated predictive gains: optional tentative trends and suggestions, with uncertainty and baseline coverage visible. Position-specific suggestions need their own alignment and cross-session validation. Never call a pause a diagnosed spelling weakness. |
| 4 — future, separate approval | Only after predictive evidence and policy evaluation: separately configurable experimental behavior, tested alongside retained Legacy and FSRS, reversible switching and compatible backups. Predictive improvement alone does not prove improved learning from a changed schedule. |

For Phase 2, define the outcome as the next eligible, first unaided spelling review
on a later day and record its actual interval. Right-censor words without follow-up;
do not label them failures. Exclude correction, hint, and meaning-quiz outcomes and
unknown historical context. Stratify or adjust for exercise, audio exposure, target
and prompt length, input method, active engine, and actual review lag.

Start with a history/spacing baseline (prior correctness, qualified review/lapse
counts, time since prior eligible review, and schedule state available at prediction
time). Partition changed spellings/reset epochs and content versions; never
reconstruct an old prompt or target from its current edited text. Only its source
length/version is retained, not an immutable prompt snapshot. Compare a small regularized model adding the aggregate features. Fit user
baselines and any transforms only on past training data. Missingness and reliability
flags need explicit treatment; never turn null latency into a fast response.

Use forward chronological splits with whole sessions kept together. Require training
labels to be observed before the validation cutoff; an example whose future outcome
crosses the cutoff must not leak into training. Tune only on earlier folds; leave the
latest period untouched. Bootstrap uncertainty by session/word, examine held-out-word
sensitivity, and predeclare the smallest useful improvement and required precision
before deciding a sample is sufficient. Compare held-out log loss/Brier score,
calibration, and discrimination, including interval and exercise strata.

Practice is adaptively selected, not randomly sampled. Opt-in capture and reliability
filtering also select people and attempts; report their coverage, exclusion reasons,
and sensitivity analyses. A single notebook cannot establish generalization to other
learners. Compare feature ablations to detect a model that merely recognizes a long
review interval or a different keyboard. No Phase 2 model or learning-gain claim has
been implemented or demonstrated by Phase 1.

## Phase 1 change map and verification

- `static/typing_metrics.js`: bounded collector and exercise-scoped browser listeners.
- `static/app.js`: presentation, playback, answer snapshot/retry, consent, and cleanup
  integration; settings/delete controls. Existing grading and `elapsed_ms` calculation
  remain unchanged.
- `typewriter/typing_metrics.py`: whitelist validation, eligibility, and session-group
  context; `typewriter/store.py`: additive migration/backup, transactional persistence,
  optional backup fields, opt-in settings, and deletion.
- `typewriter/web.py`: token-protected delete endpoint.
- `templates/index.html`, `static/style.css`: local experimental settings and script.
- `tests/typing-metrics.cjs`: clock-controlled timing/edit/interrupt/audio calculations
  and bounded-state checks; `tests/typing-browser.cjs`: real browser lifecycle,
  synthetic IME/paste/drop events, incomplete attempts, retry, consent, and deletion.
- `tests/test_typing_metrics.py`: input validation, metadata privacy, both scheduler
  parity, idempotency, migration, backup compatibility, consent, and endpoint tests.
- `package.json`: new checks in the browser runner. `README.md`, `docs/user-guide.md`,
  and this document explain operation, limitations, and the gated roadmap.

The new backend checks compare enabled/disabled runs at fixed review dates under both
engines, including correct, incorrect, and hinted answers: word/history/card/due state
is identical after stripping only the optional summary. A disposable-database migration
checks records and the automatic pre-migration backup. Browser tests use temporary
notebooks with provider calls disabled; a failed-response retry is exercised after the
server has committed the attempt. Histories and experimental metadata stay idempotent.

A synthetic 1,000-edit browser check observed about 0.008–0.010 ms per beforeinput/input pair across two runs
on the development machine, with no per-edit requests. This is a small implementation
cost check, not a claim about all devices or real typing performance. Composition,
paste, drop, and visibility changes are also dispatched explicitly in tests; native
IME and assistive-technology behavior across all platforms remains unverified.

No longitudinal retention experiment has been run and collection remains off until
you enable it. Before fitting baselines across keyboard/device/layout changes, add
an explicit user-selected profile or restrict analysis to a known stable setup: the
initial coarse input-method label cannot identify those changes. There are no
position-level records, personal fluency normalization, confidence scores, or
predictive models in this implementation.

Validation recorded on 19 October 2026: `.venv/bin/python -m unittest discover -s tests -q`
passed 211 backend tests; `npm test` passed the complete JavaScript/browser runner.
The latest typing browser check was also run separately after adding the answer-editor
exposure case. These checks validate the implementation and invariants, not the
hypothesis about later retention.
