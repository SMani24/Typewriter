# Scheduling laboratory

This optional, deterministic experiment uses synthetic review histories. It never
opens the production notebook, changes the app's scheduler, or exposes an FSRS
switch. The production spelling integration is described in the [ranking guide](../docs/review-ranking.md).
Independent meaning cards remain a candidate policy in this lab. Synthetic checks
are not proof of improved recall.

Use a separate environment:

```bash
python3 -m venv /tmp/typewriter-fsrs-lab
/tmp/typewriter-fsrs-lab/bin/pip install -r prototypes/requirements.txt
/tmp/typewriter-fsrs-lab/bin/python prototypes/fsrs_lab.py
/tmp/typewriter-fsrs-lab/bin/python -m unittest discover -s prototypes -v
```

The lab pins Py-FSRS 6.3.2, keeps default retention/parameters and disables fuzzing
for repeatable checks. It exercises independent spelling/meaning cards, rating
mapping, saved states, elapsed-time previews, explicit switching confirmation,
active-session rejection, spelling resets, and snapshot restoration. Legacy
comparison follows the approved fixed stages and due-only success policy.
No optimizer or production migration runs here.

The model-library API and release are documented by
[Py-FSRS](https://github.com/open-spaced-repetition/py-fsrs) and
[PyPI](https://pypi.org/project/fsrs/6.3.2/).
