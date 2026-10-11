# How Typewriter chooses words for practice

This describes the implementation as of 11 October 2026. Typewriter uses a simple,
performance-based priority score together with a staged review schedule. It does
not currently use FSRS or a fitted forgetting curve. The coefficients below are
product choices, not parameters validated against your long-term recall.

## Selection happens in two steps

First, the app decides which words are eligible. Then it sorts those words by
priority. A high score does not override the due time in a normal short review.

An enabled spelling exercise needs its own material:

| Exercise | Required material |
| --- | --- |
| Sentence spelling | A sentence containing the exact word, so it can be blanked out |
| Spelling from a meaning | A nonempty, unflagged definition |
| Audio-only spelling | A checked recording, an available selected accent or uploaded recording, and no pronunciation flag |
| Meaning quiz | An unflagged definition and three generated distractors, or at least one different unflagged notebook meaning |

A pending preparation status does not by itself exclude a word: a manually added
sentence is enough for sentence practice. Conversely, a prepared word with only
an unsuitable clue cannot enter an exercise that requires that clue. Uploaded
audio takes precedence over dictionary audio. A word can have a saved accent
exception while the global accent remains unchanged.

### Short, selected, and endless reviews

- **Start my review:** eligible spelling words whose `due` time has arrived,
  sorted by spelling priority. Take up to `review_session_size`, default 10,
  configurable from 1 to 100. Quizzes can be inserted in addition to this number.
- **Review selected:** eligible spelling words within the selection, including
  words that are not due. It uses the whole eligible selection rather than the
  short-review limit. Quiz candidates also come from that selection.
- **Practise endlessly:** build a batch of up to ten eligible spelling words.
  If any spelling words are due, that batch uses due words only. Otherwise it
  takes extra practice from all eligible spelling words. At the batch boundary,
  refresh saved results and build another batch. Avoid repeating the previous
  word immediately when another word is available. This rotation can put the
  second-ranked word before the highest-ranked one for that refill.
- **Meaning quizzes:** use a separate meaning ranking. When only meaning quizzes
  are enabled, a short review starts these directly. When spelling exercises are
  enabled but no spelling reviews are ready, the app offers an explicit choice
  of endless spelling or meaning quizzes. Unavailable choices are disabled.

Endless mode keeps only the current batch in memory; it does not accumulate an
unlimited queue. It saves each answer immediately. The quiz rhythm survives batch
refills. A word missed during a short review is due in ten minutes, rather than
being added repeatedly to that short session. The immediate correction exercise
is separate practice.

## The spelling priority score

For each word, take the **last eight unaided spelling-review answers**, ordered
by attempt ID. Drills, correction repetitions, hinted spelling answers, and
meaning answers do not enter this accuracy window.

Let:

- `n` = number of answers in that window, from 0 to 8;
- `c` = correct answers in that window;
- `h` = 1 if the latest spelling review was hinted or incorrect, otherwise 0;
- `d` = whole days overdue, with future due dates treated as zero.

The implementation computes:

```text
smoothed_success = (c + 1) / (n + 2)
priority = 4 × (1 − smoothed_success) + 2 × h + min(d / 7, 6)
```

The `+1` and `+2` behave like one hypothetical success and one hypothetical
failure. A new word starts at a neutral 50% estimate, rather than at 0% or 100%.
This estimate is a smoothing device, not a calibrated probability that you will
remember the word tomorrow.

The latest hinted review can add the help boost even though it does not enter
`n` or `c`. The implementation compares the newest hinted and unaided review IDs
for this decision. The overdue bonus rises in steps of approximately 0.143 per
whole day and reaches its cap at 42 overdue days.

### Examples

These examples assume each word is eligible and due. Scores are shown rounded;
sorting uses the full value.

| Recent unaided reviews | Latest review | Whole days overdue | Score |
| --- | --- | ---: | ---: |
| None | None | 0 | 2.00 |
| 8 correct out of 8 | Correct | 0 | 0.40 |
| 4 correct out of 8 | Incorrect | 0 | 4.00 |
| 0 correct out of 8 | Incorrect | 0 | 5.60 |
| 1 correct out of 3 | Hinted | 28 | 8.40 |
| None | None | 49 | 8.00 |

The fifth word outranks the fourth despite having fewer misses. This is why
sorting drill suggestions simply by mistake count produced the wrong order.

Spelling reviews and drill lists sort by descending score, then earlier due time,
then smaller word ID for a stable tie. A search in the drill dropdown gives prefix
matches precedence over other substring matches, then sorts each group by this
same priority. Searching does not change the saved score.

## Why these rules were chosen

The app is for correcting spelling weaknesses while keeping daily practice easy
to understand. A recent window reacts when you improve, rather than making early
mistakes follow you forever. A smoothing prior keeps one early answer from making
a word look completely mastered or hopeless. The help boost catches a struggle
that a running average could otherwise hide. The overdue bonus allows neglected
words to catch up with recently difficult ones.

The weights make recent accuracy worth up to nearly four points, an immediate
struggle worth two points, and extended neglect worth up to six points. Those
values deliberately allow sufficiently overdue words to outrank newly difficult
words. Eight answers balances responsiveness against short runs of luck; it is
not an experimentally established optimal window. These explanations are design
rationale, not evidence that this heuristic outperforms another scheduler.

## The due schedule and confidence stages

New words start at stage 0 and are due immediately. An unaided correct spelling
review advances the stage by one, up to stage 5, at most once per UTC calendar
day. The interval comes from the resulting stage:

| Stage after the review | Next review |
| ---: | --- |
| 0 | 1 day for a successful review that remains at stage 0 |
| 1 | 1 day |
| 2 | 3 days |
| 3 | 7 days |
| 4 | 14 days |
| 5 | 30 days |

An incorrect or hinted spelling review reduces the stage by one, with a floor of
zero, and schedules another review in ten minutes. A correct repetition after a
hint is still assisted practice. Drills, corrections, and meaning quizzes never
advance or reduce the spelling stage.

The once-per-day rule looks for an earlier successful unaided review on that UTC
date. Every spelling review still updates the due time: another correct answer
on the same day resets the interval from that answer without another promotion.
Consequently, repeated extra reviews can move the next due date even when the
stage does not increase. UTC midnight is a calendar boundary, not a guarantee of
24 hours between promotions.

A word with no unaided reviews is labelled **New**. Otherwise it is **Learning**
until stage 3, and **Confident** from stage 3 onward. “Confident” means it passed
this rule; it is not a measured retention probability or an IELTS score prediction.

Changing the actual spelling keeps previous answers in global history but sets a
new `recall_reset_at`, resets the stage and due time, and starts that word's
statistics and rankings afresh. Old audio is excluded until checked again. The
reset date survives backup export/import. Historical answers keep their original
text, while their word label follows the corrected spelling through the same word ID. Changing only a clue does not reset
the schedule, although changed meanings invalidate their generated distractors.

## Meaning quizzes and their frequency

Meaning ranking uses the same score formula with its own last eight unhinted
meaning answers. Its help boost is based on the latest quiz being incorrect.
Its waiting bonus uses whole days since the latest such quiz, rather than the
spelling due time. A never-quizzed meaning starts at score 2 with no waiting
bonus. Quizzes are not gated by a separate meaning due date.

Mixed sessions draw from the ranked quiz candidate pool, limited to the short
review size, the selected set's size, or ten in endless mode. When a quiz is due,
the app picks the highest-ranked candidate not yet used in that cycle; if all
have been used it returns to the highest-ranked candidate. Thus a small set can
repeat within a session. Generated distractors are used when present; otherwise
different notebook meanings supply the options. Meanings with flags are excluded.

Settings allow a fixed gap of 1–10 spelling words or a random inclusive range
within those bounds. The app chooses a new random gap after each inserted quiz.
Each spelling target counts once toward the gap, including a miss or a hinted
answer. Correction repetitions and skipped questions do not count again. A final
spelling answer can insert one last quiz before the session ends. Quizzes register
on the option click or number key; Enter continues after feedback.

## Drill suggestions and displayed accuracy

A drill is recommended when the eight-answer spelling window contains at least
two misses and either the current unaided correct streak is shorter than three
or the latest spelling review still needs help. Three consecutive correct
unaided reviews clear the recommendation. Drill repetitions do not clear it by
themselves. The three recommendations on Today use spelling priority, rather
than raw miss count. The dropdown ranks all matching words by priority.

The word list's accuracy is the percentage across all that word's unaided
spelling reviews since its latest spelling reset. The priority uses only the
recent window, so a high lifetime accuracy can coexist with a high priority after
a recent struggle. Global Progress retains historical reviews from before a
spelling change. Meaning quiz totals and drill repetitions are reported separately.

## Limits of the current method

The score does not model how quickly a particular word is forgotten, nor adjust
for word length, elapsed answer time, or the difference between hearing a word
and seeing a rich sentence clue. Answer time is stored but does not affect rank.
Many same-session correct answers can fill the recent window and make a word
look stronger without demonstrating durable recall. The daily promotion limit
reduces stage inflation, but does not remove this accuracy-window effect.

The age bonus is absolute: 14 days overdue contributes equally whether a word's
normal interval was one day or thirty days. Its cap limits the bonus but does
not guarantee every word will eventually be selected under a continuous influx
of new words and failures. Meaning quizzes also lack an independent due schedule.

An incorrect definition, sentence, or recording can create apparent learning
failures. Flagging or editing the material should come before treating those
failures as evidence that the spelling itself is difficult. This is another
reason not to describe the score as a probability of forgetting.

## Alternatives worth considering

The comparisons below describe other systems; the proposed adaptations are
suggestions, not features implemented in Typewriter.

### FSRS: the strongest candidate for personalized scheduling

FSRS models difficulty and stability and derives retrievability, the probability
of recall at a particular time. Its formulas account for elapsed time and update
memory after answers. These components are documented in the project's
[algorithm reference](https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm).

Anki exposes a desired-retention setting and can optimize FSRS parameters using
review history. Raising desired retention increases review workload. It also
offers review ordering by retrievability. See the official
[Anki deck options](https://docs.ankiweb.net/manual/deck-options).

For Typewriter, I would consider FSRS for due times and ordering once there is
useful spaced recall history. Start with supported defaults, then evaluate
personalization. Keep spelling and meaning as separate memory states. Treat a
failed or revealed spelling as a failure; never turn correction repetitions into
successful independent recall. Preserve automatic grading and optional difficulty
feedback so the keyboard workflow stays quick. Mapping Typewriter answers to
FSRS ratings would need explicit design and tests before migration.

### A simpler adaptive interval rule

A per-word ease multiplier is an intermediate option between fixed stages and a
full memory model: grow the interval after successful spaced recall and shorten
it after failures, while retaining the current weakness ranking. This is a
proposed design, not a claim to implement SuperMemo's algorithm.

SuperMemo's current public explanation describes adapting forgetting curves to
individual performance, with easier material receiving longer intervals and
forgotten material returning sooner. That supports the general direction of
adaptive spacing; its proprietary scheduler is distinct from Typewriter's rule.
See [SuperMemo's scheduling explanation](https://www.supermemo.com/en/faq/how-often-should-the-material-be-repeated).

### Better ordering without replacing the scheduler

An inexpensive experiment would rank overdue words relative to their scheduled
interval, reserve a few positions for new or long-neglected words, and group
repeated same-day answers so they cannot dominate the recent window. Track
meaning due times separately. These are my proposed changes, not current rules.
A relative-overdue policy could be evaluated alongside the probability-based
ordering described in the Anki documentation, while retaining an understandable
explanation of why each word was selected.

For persistent misses, offer shorter drills or a material check rather than
simply repeating the same clue. Repeated failures may reflect a bad exercise as
well as a hard spelling. It may also help to record recurring letter-confusion
patterns and vary example sentences, but those changes need their own evaluation.

### How to decide whether an alternative is actually better

Keep held-out reviews separated in time from drills and corrections. Compare
unaided recall after a delay, total review time, missed due words, and workload.
For a probability model, also check whether predicted recall agrees with observed
recall. Evaluate on later reviews rather than training and measuring on the same
session. An offline replay can check implementation and predictions, but cannot
prove the benefit of a new schedule whose review times were never experienced.
A gradual opt-in trial with database backups would give better evidence.

My recommendation is to keep the current explainable heuristic for now, improve
its handling of same-day evidence and separate meaning scheduling first, then
trial FSRS. Anki and SuperMemo provide useful ideas, but neither their defaults
nor their outcomes establish which settings are best for your IELTS spelling.

## Where the implementation lives

- [`typewriter/store.py`](../typewriter/store.py): attempt windows, score,
  stages, due dates, flags, statistics, and spelling resets.
- [`static/app.js`](../static/app.js): exercise eligibility, review pools,
  dropdown ordering, and choosing the next practice mode.
- [`static/review.js`](../static/review.js): priority tie-breaking, quiz rhythm,
  queue advancement, and bounded endless refills.
- [`tests/test_store.py`](../tests/test_store.py),
  [`tests/test_latest.py`](../tests/test_latest.py),
  [`tests/review.cjs`](../tests/review.cjs), and
  [`tests/latest.cjs`](../tests/latest.cjs): scheduling and regression checks.
