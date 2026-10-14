"""Offline, advisory spelling checks; never change the writer's text."""
import gzip
import re
from functools import lru_cache
from pathlib import Path

TOKEN = re.compile(r"[^\W\d_]+(?:['’][^\W\d_]+)*", re.UNICODE)


@lru_cache(maxsize=1)
def vocabulary():
    path = Path(__file__).parent / 'resources' / 'spelling' / 'english.txt.gz'
    with gzip.open(path, 'rt', encoding='utf-8') as source:
        return frozenset(line.strip() for line in source)


def check(text):
    if not isinstance(text, str) or len(text) > 100000:
        raise ValueError('Check text up to 100,000 characters at a time.')
    words = vocabulary()
    # Browser selection/highlight offsets count UTF-16 units, including emoji pairs.
    offsets = [0]
    for character in text:
        offsets.append(offsets[-1] + (2 if ord(character) > 0xffff else 1))
    errors = []
    for match in TOKEN.finditer(text):
        word = match.group().casefold().replace('’', "'")
        if word in words or word.endswith("'s") and word[:-2] in words:
            continue
        errors.append({'start':offsets[match.start()], 'end':offsets[match.end()]})
        if len(errors) >= 500:
            break
    return {'errors':errors, 'limited':len(errors) == 500}
