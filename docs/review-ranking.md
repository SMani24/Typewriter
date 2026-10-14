# How Typewriter chooses words for practice

Typewriter offers **Legacy** (the default) and opt-in **FSRS** spelling scheduling.
They decide when a word is due; exercise material decides whether it can appear.
Meaning quizzes keep their separate scores and quiz rhythm in either engine.
These policies are learning-app design choices, not measured improvements in
IELTS results or long-term retention.

## Eligible words and session length

| Exercise | Required material |
| --- | --- |
| Sentence spelling | An example containing the exact word |
| Spelling from a meaning | A nonempty, unflagged definition |
| Audio-only spelling | A checked, unflagged recording in the selected accent, or an uploaded recording |
| Meaning quiz | An unflagged definition and three generated distractors, or another different, unflagged notebook meaning |

Pending preparation does not exclude a usable manual clue. A pronunciation flag
excludes audio practice, rather than counting a recording problem as a spelling
mistake. Uploaded audio takes precedence over dictionary audio.

**Start my review** uses due eligible spelling words, up to the saved short-review
limit (default 10, adjustable from 1 to 100), plus meaning quizzes. A miss returns
to the schedule rather than repeating indefinitely in that short session. Its
immediate correction is practice only.

**Review selected** includes the whole eligible selection, even when words are
not due. **Practise endlessly** refills batches of up to ten words. Each batch
uses due words if any are available, then extra practice when none are due. It
avoids an immediate repeat when another word is available. The quiz rhythm
continues across refills, and Escape ends the session. Each answer is saved.

If spelling is enabled but nothing is due, the app offers explicit endless
practice or meaning quizzes. Meaning-only settings start quizzes directly.

## Legacy dates and recall evidence

A due, unaided correct spelling review advances a word by at most one stage per
UTC calendar day. Stages 1–5 use intervals of **1, 3, 7, 14, and 30 days**. A
correct early answer or another success after that day's promotion is saved as
extra practice: it leaves the Legacy date and stage unchanged. An early success
cannot consume a later due answer's promotion.

A wrong or hinted spelling review retains Legacy's failure behavior: one stage
back (minimum zero), due in ten minutes. Drills, corrections, and meaning quizzes
do not change its spelling stage. Legacy stages are never derived from FSRS
stability or difficulty.

New **spaced-recall evidence** admits the first actually due, unaided spelling
review per word per UTC day, with known exercise/session context. Either a miss
or a success can be that day's evidence. A hint is excluded. Selected or endless
practice can qualify when genuinely due. A UTC-day boundary is not a guarantee
of 24 elapsed hours between answers.

Lifetime unaided-answer totals and the original recent-answer statistics remain
available, including extra practice and older history. Old unknown-context
answers are not relabelled as spaced recalls. Progress shows the new measure
separately. A spelling edit resets both schedules and the word's current recall
window; historical answers stay in lifetime progress.

### Legacy priority

Take the last eight spaced-recall answers since the spelling reset. Let `n` be
the number of answers, `c` the correct count, `h` be 1 when the latest spelling
review was wrong or hinted (otherwise 0), and `d` be whole days overdue:

```text
smoothed_success = (c + 1) / (n + 2)
priority = 4 × (1 − smoothed_success) + 2 × h + min(d / 7, 6)
```

Higher scores come first. Equal scores use oldest due time, then word ID.
Unknown historical context does not enter this new evidence window. The latest
struggle signal still includes wrong/hinted reviews, including extra practice.
The smoothed success value is a ranking aid, not a calibrated recall probability.

## Coverage of neglected words

Every **fifth displayed normal spelling question** uses the oldest due eligible
word, with word ID as a deterministic tie break. The other four use the active
engine's ordinary order. A persistent counter carries across short sessions,
even one-word sessions. Meaning quizzes, selected reviews, and endless sessions
do not consume it.

Only displayed positions consume credit: ending a ten-word session after its
first question does not consume the other nine. A skipped displayed question
does consume its position. Before each new normal spelling position, the server
rechecks due time and available exercise material. Retrying the same position
request is idempotent. Coverage never admits an early or unusable word. This
provides regular opportunities for neglected words; it is not a guaranteed
waiting-time bound under unlimited incoming workload.

## FSRS dates and ordering

The spelling adapter uses [Py-FSRS 6.3.2](https://pypi.org/project/fsrs/6.3.2/),
pinned in `requirements.txt`, with supported default parameters and learning
steps, desired retention **0.9**, and fuzzing disabled. There is no optimizer or
history fitting. See the [official library](https://github.com/open-spaced-repetition/py-fsrs).

| Answer at the active schedule's due time | FSRS treatment |
| --- | --- |
| Correct unaided spelling review | Good |
| Incorrect or hinted/revealed spelling review | Again |
| Early answer, drill, or immediate correction | Practice only |
| Meaning quiz | Separate quiz score; no spelling memory update |
| Historical context recorded before this integration | Retained history; not replayed |

Unlike Legacy's daily evidence window, FSRS can update several genuinely due
learning steps on the same UTC day. The mapping does not ask for Hard/Easy ratings.
Sentence, definition, and audio clues share one spelling memory state, while their
exercise types are recorded separately.

Fresh cards have no calibrated retrievability. They come first, ordered by due
time and word ID. Other due cards use lowest current estimated retrievability
first, then due time and ID. The every-fifth coverage position still applies.
Selected and endless extra practice retain their explicit early-practice rules.

Existing words start as fresh FSRS cards at the integration boundary. No mature
memory is invented from Legacy stages or ambiguous old answers. Forward qualified
answers train FSRS in the background while Legacy is active, so a later opt-in
can already have some informed states. The workload preview exposes fresh cards.

## Switching safely

Use **Settings → Spelling scheduler → Preview switching**. The dialog shows both
due counts, fresh FSRS cards, words currently dated in the next seven days, and
example date differences. Seven-day counts are saved dates, not a forecast of
future reviews after new answers. Confirm explicitly to switch, or cancel.

Both schedulers retain separate states. Legacy continues its approved due-only
success/daily-promotion and failure rules; FSRS consumes qualified reviews that
were due under the active engine. A correct extra answer does not advance either
state. Thus both states reflect actual answers under this defined mapping; they
are not counterfactual simulations of answers you might have given on other dates.
Switching selects dates without overwriting either state or resetting elapsed
time. Overdue dates remain overdue. Returning to Legacy is supported in Settings.

The setting applies to this local notebook. Separate data directories are
independent. A server-tracked practice session freezes its engine, configuration,
exercise settings, and quiz rhythm. The server rejects switching during a live
session and rejects answers with incompatible session context. One session can
be open per notebook. Heartbeats renew a three-minute lease; an abandoned tab
expires, and its expired session cannot resume. Normal tab closing releases it.
An expired session keeps all saved answers; start another session to continue.

Preview tokens cover materials, flags, answers, states, settings, and coverage
credit. They expire after three minutes. Concurrent changes or a newly due card
require another preview. Confirmation is atomic. Answer request IDs prevent a
lost response followed by a retry from recording another grade.

## Drills and meanings

Drill recommendations retain recent unaided-answer mistakes and the latest
struggle signal. Three consecutive correct unaided reviews clear a suggestion.
Completing at least ten correct drill repetitions at 80% accuracy reduces that
word's drill priority to 25% of its review score for 24 hours from its last saved
drill answer. A later wrong/hinted spelling review clears the reduction. It does
not change due dates, recall evidence, or FSRS memory.

Meaning quizzes rank their own recent answers and time since the last quiz. Their
frequency is fixed or sampled uniformly from the saved range after each quiz.
Corrections and skipped questions do not count as additional spelling answers for
quiz cadence. Meaning questions do not update either spelling scheduler. Separate
meaning due dates remain future work; switching spelling engines keeps current
quizzes usable.

## Storage, upgrade and backup compatibility

SQLite schema version 2 adds versioned spelling states, event decisions/configuration,
coverage credit, and temporary session records. An existing older notebook gets a
physical SQLite backup in its local `backups/` directory before migration. Old
words, stages, due instants, flags, settings and original answer fields are kept.
Uncertain historical context stays unknown; excluded old events are checkpointed.

JSON **format 2** includes both spelling states, library/policy configuration,
active choice, coverage credit, reset cutoffs, event cursors, flags, answer history,
and the essay draft. Local session tokens, provider keys and connection settings
are excluded. Card IDs and event cursors are remapped when words are imported.
A complete restore into an empty notebook restores the scheduler choice. Merging
into an existing notebook adds new words without replacing existing states or
silently changing its engine or coverage counter. Repeated imports do not duplicate
history. Unsupported state/configuration versions fail before writing.

Older format-1 backups are accepted, with Legacy selected on an empty restore and
fresh FSRS cards. Imported recordings still need checking; uploaded audio files
must be copied with the data directory, as before. To roll back application code
to a version predating schema 2, stop the app and use a matching pre-upgrade
physical backup. To change learning schedules normally, use the reversible
Settings switch and keep all subsequent progress.
