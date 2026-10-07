"""SQLite storage, honest practice statistics, and a deliberately simple scheduler."""
import json
import re
import sqlite3
import unicodedata
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

DEFAULTS = {
    "proxy_enabled": False, "proxy_type": "socks5h", "proxy_host": "127.0.0.1",
    "proxy_port": 10808, "proxy_username": "", "proxy_password": "",
    "model": "gemini-3.6-flash", "auto_ai": True, "batch_size": 5,
    "daily_budget": 20, "requests_per_minute": 4,
}


def now():
    return datetime.now(timezone.utc).isoformat()


def clean_word(value):
    if not isinstance(value, str):
        raise ValueError("Enter a word to practise.")
    word = " ".join(unicodedata.normalize("NFKC", value).strip().split()).lower()
    if not re.fullmatch(r"[a-z]+(?:[ '\-][a-z]+)*", word) or len(word) > 80:
        raise ValueError("Use an English word or short phrase (up to 80 characters).")
    return word


def normalize_answer(value):
    return " ".join(unicodedata.normalize("NFKC", value).strip().lower().split())


def blank_sentence(word, sentence):
    return re.sub(r"(?<!\w)" + re.escape(word) + r"(?!\w)", "________", sentence, flags=re.I)


def contains_word(word, sentence):
    return bool(re.search(r"(?<!\w)" + re.escape(word) + r"(?!\w)", sentence, re.I))


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.db() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS words (
                    id INTEGER PRIMARY KEY, word TEXT UNIQUE NOT NULL,
                    definition TEXT NOT NULL DEFAULT '', sentence TEXT NOT NULL DEFAULT '',
                    tip TEXT NOT NULL DEFAULT '', tag TEXT NOT NULL DEFAULT '',
                    sources TEXT NOT NULL DEFAULT '{}', audio_url TEXT NOT NULL DEFAULT '',
                    created TEXT NOT NULL, updated TEXT NOT NULL, due TEXT NOT NULL,
                    stage INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
                    enrichment_error TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS attempts (
                    id INTEGER PRIMARY KEY, word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
                    answer TEXT NOT NULL, correct INTEGER NOT NULL, mode TEXT NOT NULL,
                    hinted INTEGER NOT NULL, elapsed_ms INTEGER NOT NULL, created TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS attempts_word ON attempts(word_id);
                CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS key_usage (
                    key_id TEXT NOT NULL, day TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0,
                    cooldown REAL NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '',
                    PRIMARY KEY (key_id, day)
                );
                CREATE TABLE IF NOT EXISTS cache (name TEXT PRIMARY KEY, value TEXT NOT NULL);
            """)

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def settings(self, private=False):
        with self.db() as db:
            values = {**DEFAULTS, **{r["name"]: json.loads(r["value"]) for r in db.execute("SELECT * FROM settings")}}
        if not private:
            values["proxy_password_set"] = bool(values["proxy_password"])
            values["proxy_password"] = ""
        return values

    def save_settings(self, data):
        values = self.settings(private=True)
        for key in DEFAULTS:
            if key in data:
                if key == "proxy_password" and data[key] == "" and not data.get("clear_proxy_password"):
                    continue
                values[key] = data[key]
        for key in ["proxy_enabled", "auto_ai"]:
            if not isinstance(values[key], bool):
                raise ValueError("Choose an on/off setting.")
        for key, low, high in [("proxy_port", 1, 65535), ("batch_size", 1, 25), ("daily_budget", 1, 2000), ("requests_per_minute", 1, 60)]:
            if not isinstance(values[key], int) or not low <= values[key] <= high:
                raise ValueError(f"{key.replace('_', ' ').capitalize()} must be between {low} and {high}.")
        if values["proxy_type"] not in ["http", "socks5h"]:
            raise ValueError("Choose HTTP or SOCKS5.")
        if not isinstance(values["proxy_host"], str) or not re.fullmatch(r"[a-zA-Z0-9.:-]{1,253}", values["proxy_host"]):
            raise ValueError("Enter a proxy hostname or IP address, without a URL prefix.")
        if not isinstance(values["model"], str) or not re.fullmatch(r"gemini-[a-zA-Z0-9.\-]{1,80}", values["model"]):
            raise ValueError("Enter a Gemini model name, such as gemini-3.6-flash.")
        for key in ["proxy_username", "proxy_password"]:
            if not isinstance(values[key], str) or len(values[key]) > 200:
                raise ValueError("Proxy credentials must be shorter than 200 characters.")
        with self.db() as db:
            db.executemany("INSERT OR REPLACE INTO settings VALUES (?,?)", [(k, json.dumps(v)) for k, v in values.items()])
        return self.settings()

    def list_words(self):
        with self.db() as db:
            rows = db.execute("""SELECT w.*,
                COUNT(CASE WHEN a.mode='review' AND a.hinted=0 THEN 1 END) AS reviews,
                COUNT(CASE WHEN a.mode='review' AND a.hinted=0 AND a.correct=1 THEN 1 END) AS correct_reviews,
                COUNT(CASE WHEN a.mode='drill' THEN 1 END) AS drills,
                MAX(a.created) AS last_practised
                FROM words w LEFT JOIN attempts a ON a.word_id=w.id GROUP BY w.id ORDER BY w.created DESC,w.id DESC""").fetchall()
            words = []
            for row in rows:
                w = dict(row)
                w["sources"] = json.loads(w["sources"])
                w["clue"] = blank_sentence(w["word"], w["sentence"]) if contains_word(w["word"], w["sentence"]) else ""
                w["accuracy"] = round(100 * w["correct_reviews"] / w["reviews"]) if w["reviews"] else None
                w["is_due"] = w["due"] <= now()
                w["state"] = "New" if not w["reviews"] else ("Confident" if w["stage"] >= 3 else "Learning")
                words.append(w)
            return words

    def word(self, word_id):
        return next((w for w in self.list_words() if w["id"] == word_id), None)

    def add_words(self, items):
        if not isinstance(items, list) or not 1 <= len(items) <= 500:
            raise ValueError("Add between 1 and 500 words at a time.")
        prepared = [self.validate_word(i) for i in items]
        added, duplicates = [], []
        with self.db() as db:
            for item in prepared:
                if db.execute("SELECT id FROM words WHERE word=?", (item["word"],)).fetchone():
                    duplicates.append(item["word"])
                    continue
                stamp = now()
                fields = [item[k] for k in ["word", "definition", "sentence", "tip", "tag"]]
                sources = json.dumps({k: "manual" for k in ["definition", "sentence", "tip"] if item[k]})
                status = "ready" if item["definition"] and item["sentence"] and item["tip"] else "pending"
                cur = db.execute("INSERT INTO words (word,definition,sentence,tip,tag,sources,created,updated,due,status) VALUES (?,?,?,?,?,?,?,?,?,?)", (*fields, sources, stamp, stamp, stamp, status))
                added.append(cur.lastrowid)
        return {"added": added, "duplicates": duplicates}

    @staticmethod
    def validate_word(item):
        if not isinstance(item, dict):
            raise ValueError("Each word needs a word field.")
        result = {"word": clean_word(item.get("word", ""))}
        for field in ["definition", "sentence", "tip", "tag"]:
            value = item.get(field, "")
            if not isinstance(value, str) or len(value) > (60 if field == "tag" else 2000):
                raise ValueError(f"{field.capitalize()} is too long.")
            result[field] = value.strip()
        if result["sentence"] and not contains_word(result["word"], result["sentence"]):
            raise ValueError("The example sentence must contain the exact word you're practising.")
        return result

    def edit_word(self, word_id, data):
        original = self.word(word_id)
        if not original:
            raise KeyError("Word not found.")
        item = self.validate_word({**original, **{k: v for k, v in data.items() if k in ["definition", "sentence", "tip", "tag"]}})
        sources = original["sources"]
        for field in ["definition", "sentence", "tip"]:
            if field in data:
                sources[field] = data.get("source", "manual") if data.get("source") == "Cambridge" else "manual"
        audio = data.get("audio_url", original["audio_url"]) if data.get("source") == "Cambridge" else original["audio_url"]
        if audio and not re.fullmatch(r"https://dictionary\.cambridge\.org/[^\s]+", audio):
            raise ValueError("Unsupported pronunciation URL.")
        status = "ready" if all(item[k] for k in ["definition", "sentence", "tip"]) else "pending"
        with self.db() as db:
            db.execute("UPDATE words SET definition=?,sentence=?,tip=?,tag=?,sources=?,audio_url=?,updated=?,status=?,enrichment_error='',version=version+1 WHERE id=?", (item["definition"], item["sentence"], item["tip"], item["tag"], json.dumps(sources), audio, now(), status, word_id))
        return self.word(word_id)

    def enrich_word(self, word_id, content, source):
        # Read at commit time: a user may have edited the word during a network request.
        with self.db() as db:
            row = db.execute("SELECT * FROM words WHERE id=?", (word_id,)).fetchone()
            if not row:
                return False
            item = dict(row)
            sources = json.loads(item["sources"])
            for field in ["definition", "sentence", "tip"]:
                value = content.get(field, "")
                if not isinstance(value, str) or not value.strip() or len(value) > 2000:
                    continue
                if field == "sentence" and not contains_word(item["word"], value):
                    continue
                if not item[field]:
                    item[field] = value.strip()
                    sources[field] = source
            status = "ready" if all(item[k] for k in ["definition", "sentence", "tip"]) else "pending"
            db.execute("UPDATE words SET definition=?,sentence=?,tip=?,sources=?,updated=?,status=?,enrichment_error='' WHERE id=?", (item["definition"], item["sentence"], item["tip"], json.dumps(sources), now(), status, word_id))
            return status == "ready"

    def delete_word(self, word_id):
        with self.db() as db:
            db.execute("DELETE FROM words WHERE id=?", (word_id,))

    def attempt(self, word_id, data):
        answer = data.get("answer", "")
        mode = data.get("mode", "review")
        if not isinstance(answer, str) or not answer.strip() or len(answer) > 200:
            raise ValueError("Type an answer first (up to 200 characters).")
        if mode not in ["review", "drill", "correction"] or not isinstance(data.get("hinted", False), bool):
            raise ValueError("Invalid practice mode.")
        elapsed = data.get("elapsed_ms", 0)
        if not isinstance(elapsed, int) or not 0 <= elapsed <= 86400000:
            raise ValueError("Invalid answer time.")
        stamp = now()
        with self.db() as db:
            row = db.execute("SELECT * FROM words WHERE id=?", (word_id,)).fetchone()
            if not row:
                raise KeyError("Word not found.")
            correct = normalize_answer(answer) == row["word"]
            hinted = data.get("hinted", False)
            db.execute("INSERT INTO attempts (word_id,answer,correct,mode,hinted,elapsed_ms,created) VALUES (?,?,?,?,?,?,?)", (word_id, answer.strip(), int(correct), mode, int(hinted), elapsed, stamp))
            # Drilling, hints and corrections never move a word into a confident state.
            # Only one successful promotion per UTC day, even across repeat sessions.
            if mode == "review":
                stage = row["stage"]
                if correct and not hinted:
                    last = db.execute("SELECT created FROM attempts WHERE word_id=? AND mode='review' AND correct=1 AND hinted=0 ORDER BY id DESC LIMIT 1 OFFSET 1", (word_id,)).fetchone()
                    if not last or last["created"][:10] != stamp[:10]:
                        stage = min(stage + 1, 5)
                    interval = [1, 1, 3, 7, 14, 30][stage]
                else:
                    stage = max(0, stage - 1)
                    interval = 0
                due = (datetime.now(timezone.utc) + (timedelta(days=interval) if interval else timedelta(minutes=10))).isoformat()
                db.execute("UPDATE words SET stage=?,due=? WHERE id=?", (stage, due, word_id))
        return {"correct": correct, "expected": row["word"], "answer": answer.strip(), "tip": row["tip"], "word": self.word(word_id)}

    def progress(self):
        with self.db() as db:
            history = [dict(r) for r in db.execute("SELECT substr(created,1,10) AS day, COUNT(*) AS total, SUM(correct) AS correct FROM attempts WHERE mode='review' AND hinted=0 GROUP BY day ORDER BY day DESC LIMIT 30")]
            mistakes = [dict(r) for r in db.execute("SELECT w.word,a.answer,COUNT(*) AS count FROM attempts a JOIN words w ON w.id=a.word_id WHERE a.correct=0 GROUP BY w.word,a.answer ORDER BY count DESC LIMIT 8")]
            totals = dict(db.execute("SELECT COUNT(CASE WHEN mode='review' AND hinted=0 THEN 1 END) AS reviews, COUNT(CASE WHEN mode='review' AND hinted=0 AND correct=1 THEN 1 END) AS correct, COUNT(CASE WHEN mode='drill' THEN 1 END) AS drills FROM attempts").fetchone())
        return {"history": history, "mistakes": mistakes, **totals}

    def export(self):
        with self.db() as db:
            words = [dict(r) for r in db.execute("SELECT * FROM words")]
            attempts = [dict(r) for r in db.execute("SELECT * FROM attempts")]
        return {"format": "typewriter", "version": 1, "exported": now(), "words": words, "attempts": attempts}

    def import_backup(self, data):
        if not isinstance(data, dict) or data.get("format") != "typewriter" or data.get("version") != 1:
            raise ValueError("Choose a Typewriter backup file.")
        words, attempts = data.get("words"), data.get("attempts")
        if not isinstance(words, list) or not isinstance(attempts, list) or len(words) > 10000 or len(attempts) > 100000:
            raise ValueError("Invalid or oversized backup.")
        # Validate everything before modifying the database. Merge new words only;
        # repeated imports cannot duplicate existing practice records.
        validated = []
        ids = set()
        for w in words:
            item = self.validate_word(w)
            old_id = w.get("id")
            if not isinstance(old_id, int) or old_id in ids:
                raise ValueError("Invalid word IDs in backup.")
            ids.add(old_id)
            for field in ["created", "due", "updated"]:
                try:
                    parsed = datetime.fromisoformat(w[field])
                    if parsed.tzinfo is None:
                        raise ValueError()
                except (ValueError, KeyError, TypeError):
                    raise ValueError("Invalid dates in backup.") from None
            if not isinstance(w.get("stage"), int) or not 0 <= w["stage"] <= 5:
                raise ValueError("Invalid review stage.")
            validated.append((w, item))
        for a in attempts:
            if not isinstance(a, dict) or a.get("word_id") not in ids or a.get("mode") not in ["review", "drill", "correction"] or a.get("correct") not in [0, 1] or a.get("hinted") not in [0, 1] or not isinstance(a.get("answer"), str) or len(a["answer"]) > 200 or not isinstance(a.get("elapsed_ms"), int) or not 0 <= a["elapsed_ms"] <= 86400000:
                raise ValueError("Invalid practice records in backup.")
            try:
                if datetime.fromisoformat(a["created"]).tzinfo is None:
                    raise ValueError()
            except (ValueError, KeyError, TypeError):
                raise ValueError("Invalid practice dates.") from None
        added, id_map = 0, {}
        with self.db() as db:
            for original, item in validated:
                if db.execute("SELECT id FROM words WHERE word=?", (item["word"],)).fetchone():
                    continue
                status = "ready" if all(item[k] for k in ["definition", "sentence", "tip"]) else "pending"
                cur = db.execute("INSERT INTO words (word,definition,sentence,tip,tag,sources,created,updated,due,stage,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)", (item["word"], item["definition"], item["sentence"], item["tip"], item["tag"], json.dumps({k: "imported" for k in ["definition", "sentence", "tip"] if item[k]}), original["created"], original["updated"], original["due"], original["stage"], status))
                id_map[original["id"]] = cur.lastrowid
                added += 1
            for a in attempts:
                if a["word_id"] in id_map:
                    db.execute("INSERT INTO attempts (word_id,answer,correct,mode,hinted,elapsed_ms,created) VALUES (?,?,?,?,?,?,?)", (id_map[a["word_id"]], a["answer"], a["correct"], a["mode"], a["hinted"], a["elapsed_ms"], a["created"]))
        return {"added": added, "skipped": len(words) - added}
