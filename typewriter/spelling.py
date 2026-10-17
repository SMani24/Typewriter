"""Offline, advisory spelling checks; never change the writer's text."""
import hashlib
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


@lru_cache(maxsize=1)
def dictionary_fingerprint():
    return hashlib.sha256((Path(__file__).parent/'resources'/'spelling'/'english.txt.gz').read_bytes()).hexdigest()


def normalize_personal_word(value):
    if not isinstance(value,str) or len(value)>80 or not TOKEN.fullmatch(value.strip()):
        raise ValueError("Add one word, up to 80 letters, to your personal dictionary.")
    return value.strip().casefold().replace('’', "'")


def check(text, personal=()):
    if not isinstance(text, str) or len(text) > 100000:
        raise ValueError('Check text up to 100,000 characters at a time.')
    words = vocabulary()
    personal=frozenset(personal)
    units=0;previous=0
    errors = []
    for match in TOKEN.finditer(text):
        units+=sum(2 if ord(c)>0xffff else 1 for c in text[previous:match.start()])
        start=units;units+=sum(2 if ord(c)>0xffff else 1 for c in match.group());previous=match.end()
        word = match.group().casefold().replace('’', "'")
        if word in personal or word in words or word.endswith("'s") and word[:-2] in words:
            continue
        errors.append({'start':start, 'end':units})
        if len(errors) >= 500:
            break
    return {'errors':errors, 'limited':len(errors) == 500}
