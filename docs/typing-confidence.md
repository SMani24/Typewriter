# Typing as a clue to word familiarity

This is a proposal, not an implemented feature. No new keystroke recording,
confidence scoring, or scheduler changes were added for this request.

I think it could help distinguish a comfortable correct answer from one that took
effort. It should begin as a weak additional signal, with accuracy remaining the
main evidence. A slow correct answer is still correct, and a quick answer during
a repeated-word drill is not evidence of remembering that word tomorrow.

## Similar research

SlimStampen is a close example: it combines response time and accuracy to adapt
vocabulary repetition. In a published study, typed response latency meant the
time from the prompt appearing to the first keypress, rather than time to finish
typing the whole word. That distinction is useful here because it separates some
retrieval effort from typing execution. The study concerns vocabulary translation,
so its results do not directly validate an IELTS spelling scheduler.
[Wilschut et al., 2021](https://www.frontiersin.org/journals/artificial-intelligence/articles/10.3389/frai.2021.780131/full).

Keystroke research also finds effects of word frequency and word structure on
initial and subsequent key timings, even in copying tasks. Typing rhythm therefore
contains linguistic information, but it is not a clean measure of recall alone.
[Feldman, Dale and van Rij, 2019](https://www.frontiersin.org/journals/communication/articles/10.3389/fcomm.2019.00017/full).

## How I would approach it later

Keep three quantities separate: time to begin an answer, active time typing the
word, and changes made before submission. Compare active typing against that
person's own baseline for a similar word length, keyboard and task. Repeated pauses
at the same spelling segment across different days would be more interesting than
a single slow answer.

Backspace alone is not a knowledge error. An immediately fixed adjacent-key slip
can look different from deleting an uncertain suffix and trying another, but those
patterns overlap. Any distinction should be probabilistic, supported by repeated
observations, and never silently turn a correct answer into a failed review.

Timing would start only when the exercise is actually ready. Audio loading,
recording length, reading a sentence clue, tab switching, long interruptions,
pasting and input-method composition would otherwise distort the result. Separate
exercise types need separate baselines; show-spelling drills, corrections and hints
would stay outside unaided-recall evidence.

My preferred first experiment would be optional local summaries, such as first-input
delay, active typing duration, revision count and interruption flags, rather than
a retained transcript of every keystroke. The initial product could suggest a drill
or display a tentative confidence trend. Before changing review dates, compare its
predictions with actual unaided spelling performance on later days, using held-out
sessions. It should improve those predictions beyond accuracy and ordinary spacing
alone. Until then, keep Legacy and FSRS as they are.

Typewriter already saves total `elapsed_ms` per attempt. That includes time before
submission and does not isolate stimulus readiness, recall or typing. Those existing
values are not currently used to grade knowledge and are insufficient on their own
for this proposal.
