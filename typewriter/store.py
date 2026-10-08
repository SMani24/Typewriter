"""SQLite storage, honest practice statistics, and a deliberately simple scheduler."""
import hashlib
import json
import re
import sqlite3
import unicodedata
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from .models import normalize_model

DEFAULTS = {
    "proxy_enabled": False, "proxy_type": "socks5h", "proxy_host": "127.0.0.1",
    "proxy_port": 10808, "proxy_username": "", "proxy_password": "",
    "model": "gemini-flash-latest", "auto_ai": True, "batch_size": 5,
    "daily_budget": 20, "requests_per_minute": 4,
    "review_enabled": True, "drill_enabled": True,
    "sentence_enabled": True, "definition_enabled": True, "audio_enabled": True,
    "meaning_enabled": True, "preparation_method": "api", "offline_batch_size": 20,
    "quiz_interval_mode": "fixed", "quiz_interval_min": 5, "quiz_interval_max": 5,
    "review_session_size": 10,
    "pronunciation_accent": "uk",
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


def validate_distractors(values, definition):
    if not isinstance(values, list) or len(values) != 3 or any(not isinstance(v, str) or not v.strip() or len(v) > 500 for v in values):
        raise ValueError("Quiz options need three different, nonempty meanings (up to 500 characters each).")
    values = [v.strip() for v in values]
    if len({v.casefold() for v in [definition.strip(), *values]}) != 4:
        raise ValueError("Quiz options must differ from each other and the correct meaning.")
    return values


def validate_audio_urls(values):
    if not isinstance(values, dict) or any(k not in ("uk", "us") or not isinstance(v, str) or not re.fullmatch(r"https://dictionary\.cambridge\.org/[^\s]+", v) for k, v in values.items()):
        raise ValueError("Unsupported pronunciation URLs. Use UK/US Cambridge recordings.")
    return values


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
                CREATE TABLE IF NOT EXISTS app_log (
                    id INTEGER PRIMARY KEY, created TEXT NOT NULL,
                    level TEXT NOT NULL, message TEXT NOT NULL
                );
            """)
            columns = {r["name"] for r in db.execute("PRAGMA table_info(words)")}
            for name, definition in {"audio_flagged": "INTEGER NOT NULL DEFAULT 0", "audio_verified": "INTEGER NOT NULL DEFAULT 0", "audio_file": "TEXT NOT NULL DEFAULT ''", "meaning_flagged": "INTEGER NOT NULL DEFAULT 0", "distractors": "TEXT NOT NULL DEFAULT '[]'", "audio_urls": "TEXT NOT NULL DEFAULT '{}'"}.items():
                if name not in columns:
                    db.execute(f"ALTER TABLE words ADD COLUMN {name} {definition}")

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
        for key in ["proxy_enabled", "auto_ai", "review_enabled", "drill_enabled", "sentence_enabled", "definition_enabled", "audio_enabled", "meaning_enabled"]:
            if not isinstance(values[key], bool):
                raise ValueError("Choose an on/off setting.")
        if not values["review_enabled"] and not values["drill_enabled"]:
            raise ValueError("Keep at least one practice mode active.")
        if values["review_enabled"] and not any(values[k] for k in ("sentence_enabled", "definition_enabled", "audio_enabled", "meaning_enabled")):
            raise ValueError("Choose at least one review exercise, or turn off review sessions.")
        if values["preparation_method"] not in ("api", "offline", "manual"):
            raise ValueError("Choose Gemini API, another LLM, or manual preparation.")
        if values["pronunciation_accent"] not in ("uk", "us"):
            raise ValueError("Choose UK or US pronunciation.")
        if values["quiz_interval_mode"] not in ("fixed", "range"):
            raise ValueError("Choose a fixed quiz interval or a random range.")
        for key in ("quiz_interval_min", "quiz_interval_max"):
            if type(values[key]) is not int or not 1 <= values[key] <= 10:
                raise ValueError("Quiz intervals must be whole numbers between 1 and 10.")
        if values["quiz_interval_min"] > values["quiz_interval_max"] or values["quiz_interval_mode"] == "fixed" and values["quiz_interval_min"] != values["quiz_interval_max"]:
            raise ValueError("The minimum quiz interval cannot exceed the maximum; fixed intervals need matching values.")
        for key, low, high in [("review_session_size", 1, 100), ("offline_batch_size", 1, 100), ("proxy_port", 1, 65535), ("batch_size", 1, 25), ("daily_budget", 1, 2000), ("requests_per_minute", 1, 60)]:
            if type(values[key]) is not int or not low <= values[key] <= high:
                raise ValueError(f"{key.replace('_', ' ').capitalize()} must be between {low} and {high}.")
        if values["proxy_type"] not in ["http", "socks5h"]:
            raise ValueError("Choose HTTP or SOCKS5.")
        if not isinstance(values["proxy_host"], str) or not re.fullmatch(r"[a-zA-Z0-9.:-]{1,253}", values["proxy_host"]):
            raise ValueError("Enter a proxy hostname or IP address, without a URL prefix.")
        values["model"] = normalize_model(values["model"])
        for key in ["proxy_username", "proxy_password"]:
            if not isinstance(values[key], str) or len(values[key]) > 200:
                raise ValueError("Proxy credentials must be shorter than 200 characters.")
        with self.db() as db:
            db.executemany("INSERT OR REPLACE INTO settings VALUES (?,?)", [(k, json.dumps(v)) for k, v in values.items()])
        return self.settings()

    def log(self, level, message):
        # Callers supply curated messages only, never provider bodies or exception text.
        with self.db() as db:
            db.execute("INSERT INTO app_log (created,level,message) VALUES (?,?,?)", (now(), level, message))
            db.execute("DELETE FROM app_log WHERE id NOT IN (SELECT id FROM app_log ORDER BY id DESC LIMIT 500)")

    def logs(self, limit=50):
        with self.db() as db:
            return [dict(r) for r in db.execute("SELECT * FROM app_log ORDER BY id DESC LIMIT ?", (limit,))]

    def job_state(self, value=None):
        with self.db() as db:
            if value is not None:
                db.execute("INSERT OR REPLACE INTO cache VALUES ('preparation-job',?)", (json.dumps(value),))
            row = db.execute("SELECT value FROM cache WHERE name='preparation-job'").fetchone()
            return json.loads(row["value"]) if row else None

    def list_words(self):
        accent = self.settings()["pronunciation_accent"]
        with self.db() as db:
            rows = db.execute("""SELECT w.*,
                COUNT(CASE WHEN a.mode='review' AND a.hinted=0 THEN 1 END) AS reviews,
                COUNT(CASE WHEN a.mode='review' AND a.hinted=0 AND a.correct=1 THEN 1 END) AS correct_reviews,
                COUNT(CASE WHEN a.mode='drill' THEN 1 END) AS drills,
                MAX(a.created) AS last_practised
                FROM words w LEFT JOIN attempts a ON a.word_id=w.id GROUP BY w.id ORDER BY w.created DESC,w.id DESC""").fetchall()
            recent = db.execute("""WITH ranked AS (
                SELECT id,word_id,mode,hinted,correct,created,
                ROW_NUMBER() OVER (PARTITION BY word_id,mode,hinted ORDER BY id DESC) AS position
                FROM attempts WHERE mode IN ('review','meaning')
            ) SELECT word_id,mode,hinted,COUNT(*) AS total,SUM(correct) AS correct,
                MAX(CASE WHEN position=1 THEN id END) AS last_id,
                MAX(CASE WHEN position=1 THEN correct END) AS last_correct,
                MAX(CASE WHEN position=1 THEN created END) AS last_created
                FROM ranked WHERE position<=8 GROUP BY word_id,mode,hinted""").fetchall()
            results = {(r["word_id"], r["mode"], r["hinted"]): dict(r) for r in recent}
            timestamp = datetime.now(timezone.utc)
            words = []
            for row in rows:
                w = dict(row)
                w["sources"] = json.loads(w["sources"])
                w["distractors"] = json.loads(w["distractors"])
                w["audio_urls"] = json.loads(w["audio_urls"])
                w["audio_revision"] = hashlib.sha256(json.dumps([w["audio_file"],w["audio_urls"],w["audio_url"],w["audio_flagged"]],sort_keys=True).encode()).hexdigest()[:16]
                selected_audio = w["audio_urls"].get(accent) if w["audio_urls"] else w["audio_url"] if accent == "uk" else ""
                w["audio_eligible"] = bool(w["audio_verified"] and not w["audio_flagged"] and (w["audio_file"] or selected_audio))
                w["clue"] = blank_sentence(w["word"], w["sentence"]) if contains_word(w["word"], w["sentence"]) else ""
                w["accuracy"] = round(100 * w["correct_reviews"] / w["reviews"]) if w["reviews"] else None
                w["is_due"] = w["due"] <= now()
                w["state"] = "New" if not w["reviews"] else ("Confident" if w["stage"] >= 3 else "Learning")
                recall = results.get((w["id"], "review", 0), {})
                assisted = results.get((w["id"], "review", 1), {})
                latest = max((recall, assisted), key=lambda r: r.get("last_id", 0))
                meanings = results.get((w["id"], "meaning", 0), {})
                w["recent_reviews"] = recall.get("total", 0)
                w["recent_accuracy"] = round(100 * recall["correct"] / recall["total"]) if recall else None
                w["needs_help"] = bool(latest and (latest is assisted or not latest["last_correct"]))
                overdue = max(0, (timestamp - datetime.fromisoformat(w["due"])).total_seconds() / 86400)
                w["review_priority"] = self.practice_priority(recall, w["needs_help"], overdue)
                meaning_age = max(0, (timestamp - datetime.fromisoformat(meanings["last_created"])).total_seconds() / 86400) if meanings else 0
                w["meaning_priority"] = self.practice_priority(meanings, bool(meanings and not meanings["last_correct"]), meaning_age)
                words.append(w)
            return words

    @staticmethod
    def practice_priority(results, needs_help, days_waiting):
        # A small prior gives new words a fair place. Recent struggles matter more
        # than lifetime totals, while old overdue words gradually catch up.
        success = (results.get("correct", 0) + 1) / (results.get("total", 0) + 2)
        return 4 * (1 - success) + 2 * needs_help + min(int(days_waiting) / 7, 6)

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
        if item["definition"] != original["definition"]:
            sources.pop("distractors", None)
        for field in ["definition", "sentence", "tip"]:
            if field in data and (item[field] != original[field] or data.get("source") == "Cambridge" and field in ["definition", "sentence"]):
                sources[field] = "Cambridge" if data.get("source") == "Cambridge" and field in ["definition", "sentence"] else "manual"
        audio = data.get("audio_url", original["audio_url"]) if data.get("source") == "Cambridge" else original["audio_url"]
        audio_urls = validate_audio_urls(data.get("audio_urls", original["audio_urls"])) if data.get("source") == "Cambridge" else original["audio_urls"]
        if not isinstance(audio, str) or audio and not re.fullmatch(r"https://dictionary\.cambridge\.org/[^\s]+", audio):
            raise ValueError("Unsupported pronunciation URL.")
        status = "ready" if all(item[k] for k in ["definition", "sentence", "tip"]) else "pending"
        with self.db() as db:
            db.execute("UPDATE words SET definition=?,sentence=?,tip=?,tag=?,sources=?,audio_url=?,updated=?,status=?,enrichment_error='',version=version+1 WHERE id=?", (item["definition"], item["sentence"], item["tip"], item["tag"], json.dumps(sources), audio, now(), status, word_id))
            db.execute("UPDATE words SET audio_urls=? WHERE id=?", (json.dumps(audio_urls), word_id))
            if item["definition"] != original["definition"]:
                db.execute("UPDATE words SET meaning_flagged=0,distractors='[]' WHERE id=?", (word_id,))
        if (audio != original["audio_url"] or audio_urls != original["audio_urls"]) and not original["audio_file"]:
            with self.db() as db:
                db.execute("UPDATE words SET audio_verified=0 WHERE id=?", (word_id,))
        return self.word(word_id)

    def set_audio(self, word_id, *, flagged=None, verified=None, file=None):
        if not self.word(word_id):
            raise KeyError("Word not found.")
        updates = {}
        for key, value in (("audio_flagged", flagged), ("audio_verified", verified)):
            if value is not None:
                if not isinstance(value, bool):
                    raise ValueError("Choose an on/off audio setting.")
                updates[key] = int(value)
        if file is not None:
            if not isinstance(file, str) or file and not re.fullmatch(r"[a-f0-9]{32}\.(mp3|wav|ogg|m4a)", file):
                raise ValueError("Invalid audio file.")
            updates["audio_file"] = file
        if updates:
            with self.db() as db:
                db.execute("UPDATE words SET " + ",".join(k + "=?" for k in updates) + " WHERE id=?", (*updates.values(), word_id))
        return self.word(word_id)

    def set_meaning_flag(self, word_id, flagged):
        if not isinstance(flagged, bool):
            raise ValueError("Choose an on/off meaning flag.")
        with self.db() as db:
            if not db.execute("SELECT id FROM words WHERE id=?", (word_id,)).fetchone():
                raise KeyError("Word not found.")
            db.execute("UPDATE words SET meaning_flagged=?,version=version+1,updated=?,enrichment_error='' WHERE id=?", (int(flagged), now(), word_id))
        self.log("info", "Meaning flagged for correction." if flagged else "Meaning flag cleared.")
        return self.word(word_id)

    @staticmethod
    def replacement_fields(row, snapshot):
        if not snapshot or row["version"] != snapshot.get("version") or ("created" in snapshot and row["created"] != snapshot["created"]):
            return []
        if snapshot.get("kind") == "review":
            return ["definition", "sentence", "tip", "distractors"]
        if snapshot.get("kind") == "meaning" and row["meaning_flagged"]:
            return ["definition", "distractors"]
        return []

    def enrich_word(self, word_id, content, source, replacement=None):
        with self.db() as db:
            row = db.execute("SELECT * FROM words WHERE id=?", (word_id,)).fetchone()
            return self.enrich_row(db, row, content, source, replacement) if row else False

    @staticmethod
    def enrich_row(db, row, content, source, replacement=None):
        # Read at commit time so material typed during preparation is preserved.
        item = dict(row)
        sources = json.loads(item["sources"])
        replace = Store.replacement_fields(row, replacement)
        if replacement and not replace:
            return row["status"] == "ready" and not row["meaning_flagged"]
        for field in ["definition", "sentence", "tip"]:
            value = content.get(field, "")
            if not isinstance(value, str) or not value.strip() or len(value) > 2000:
                continue
            if field == "sentence" and not contains_word(item["word"], value):
                continue
            if not item[field] or field in replace:
                item[field] = value.strip()
                sources[field] = source
                if field == "definition":
                    item["meaning_flagged"] = 0
                    item["distractors"] = "[]"
                    sources.pop("distractors", None)
        # Options are tied to the saved definition, never to a discarded meaning.
        if content.get("distractors") is not None and isinstance(content.get("definition"), str) and item["definition"] == content["definition"].strip() and (not json.loads(item["distractors"]) or "distractors" in replace):
            try:
                item["distractors"] = json.dumps(validate_distractors(content["distractors"], item["definition"]))
                sources["distractors"] = source
            except ValueError:
                pass
        status = "ready" if all(item[k] for k in ["definition", "sentence", "tip"]) else "pending"
        changed = any(item[k] != row[k] for k in ("definition", "sentence", "tip", "distractors", "meaning_flagged"))
        db.execute("UPDATE words SET definition=?,sentence=?,tip=?,distractors=?,meaning_flagged=?,sources=?,updated=?,status=?,enrichment_error='',version=version+? WHERE id=?", (item["definition"], item["sentence"], item["tip"], item["distractors"], item["meaning_flagged"], json.dumps(sources), now(), status, int(changed), item["id"]))
        return status == "ready" and not item["meaning_flagged"]

    def delete_word(self, word_id):
        with self.db() as db:
            db.execute("DELETE FROM words WHERE id=?", (word_id,))

    def attempt(self, word_id, data):
        answer = data.get("answer", "")
        mode = data.get("mode", "review")
        if not isinstance(answer, str) or not answer.strip() or len(answer) > 200:
            raise ValueError("Type an answer first (up to 200 characters).")
        if mode not in ["review", "drill", "correction", "meaning"] or not isinstance(data.get("hinted", False), bool):
            raise ValueError("Invalid practice mode.")
        elapsed = data.get("elapsed_ms", 0)
        if not isinstance(elapsed, int) or not 0 <= elapsed <= 86400000:
            raise ValueError("Invalid answer time.")
        stamp = now()
        with self.db() as db:
            row = db.execute("SELECT * FROM words WHERE id=?", (word_id,)).fetchone()
            if not row:
                raise KeyError("Word not found.")
            if mode == "meaning":
                if "version" in data and data["version"] != row["version"]:
                    raise ValueError("This word changed during practice. Start a new session.")
                if re.fullmatch(r"distractor:[0-2]", answer):
                    options = json.loads(row["distractors"])
                    index = int(answer[-1])
                    choice = {"definition": options[index]} if index < len(options) else None
                else:
                    try:
                        chosen = int(answer)
                    except ValueError:
                        raise ValueError("Choose a meaning first.") from None
                    choice = db.execute("SELECT definition FROM words WHERE id=? AND meaning_flagged=0", (chosen,)).fetchone()
                if not choice or not row["definition"] or row["meaning_flagged"]:
                    raise ValueError("This meaning is no longer available. Start a new session.")
                correct = choice["definition"].strip().lower() == row["definition"].strip().lower()
            else:
                correct = normalize_answer(answer) == row["word"]
            hinted = data.get("hinted", False)
            recorded_answer = choice["definition"][:200] if mode == "meaning" else answer.strip()
            db.execute("INSERT INTO attempts (word_id,answer,correct,mode,hinted,elapsed_ms,created) VALUES (?,?,?,?,?,?,?)", (word_id, recorded_answer, int(correct), mode, int(hinted), elapsed, stamp))
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
        return {"correct": correct, "expected": row["definition"] if mode == "meaning" else row["word"], "answer": answer.strip(), "tip": row["tip"], "word": self.word(word_id)}

    def progress(self):
        with self.db() as db:
            history = [dict(r) for r in db.execute("SELECT substr(created,1,10) AS day, COUNT(*) AS total, SUM(correct) AS correct FROM attempts WHERE mode='review' AND hinted=0 GROUP BY day ORDER BY day DESC LIMIT 30")]
            mistakes = [dict(r) for r in db.execute("SELECT w.word,a.answer,COUNT(*) AS count FROM attempts a JOIN words w ON w.id=a.word_id WHERE a.correct=0 AND a.mode!='meaning' GROUP BY w.word,a.answer ORDER BY count DESC LIMIT 8")]
            totals = dict(db.execute("SELECT COUNT(CASE WHEN mode='review' AND hinted=0 THEN 1 END) AS reviews, COUNT(CASE WHEN mode='review' AND hinted=0 AND correct=1 THEN 1 END) AS correct, COUNT(CASE WHEN mode='drill' THEN 1 END) AS drills, COUNT(CASE WHEN mode='meaning' THEN 1 END) AS meanings, COUNT(CASE WHEN mode='meaning' AND correct=1 THEN 1 END) AS meanings_correct FROM attempts").fetchone())
        return {"history": history, "mistakes": mistakes, **totals}

    def export(self):
        with self.db() as db:
            words = [dict(r) for r in db.execute("SELECT * FROM words")]
            attempts = [dict(r) for r in db.execute("SELECT * FROM attempts")]
        for word in words:
            word["distractors"] = json.loads(word["distractors"])
            word["audio_urls"] = json.loads(word["audio_urls"])
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
            if w.get("audio_flagged", 0) not in (0, 1):
                raise ValueError("Invalid pronunciation flag in backup.")
            if w.get("meaning_flagged", 0) not in (0, 1):
                raise ValueError("Invalid meaning flag in backup.")
            options = w.get("distractors", [])
            if not isinstance(options, list):
                raise ValueError("Invalid quiz options in backup.")
            if options:
                validate_distractors(options, item["definition"])
            audio_url = w.get("audio_url", "")
            if not isinstance(audio_url, str) or audio_url and not re.fullmatch(r"https://dictionary\.cambridge\.org/[^\s]+", audio_url):
                raise ValueError("Invalid pronunciation URL in backup.")
            validate_audio_urls(w.get("audio_urls", {}))
            validated.append((w, item))
        for a in attempts:
            if not isinstance(a, dict) or a.get("word_id") not in ids or a.get("mode") not in ["review", "drill", "correction", "meaning"] or a.get("correct") not in [0, 1] or a.get("hinted") not in [0, 1] or not isinstance(a.get("answer"), str) or len(a["answer"]) > 200 or not isinstance(a.get("elapsed_ms"), int) or not 0 <= a["elapsed_ms"] <= 86400000:
                raise ValueError("Invalid practice records in backup.")
            try:
                if datetime.fromisoformat(a["created"]).tzinfo is None:
                    raise ValueError()
            except (ValueError, KeyError, TypeError):
                raise ValueError("Invalid practice dates.") from None
        added, id_map = 0, {}
        with self.db() as db:
            for original, item in validated:
                existing = db.execute("SELECT id FROM words WHERE word=?", (item["word"],)).fetchone()
                if existing:
                    continue
                status = "ready" if all(item[k] for k in ["definition", "sentence", "tip"]) else "pending"
                cur = db.execute("INSERT INTO words (word,definition,sentence,tip,tag,sources,created,updated,due,stage,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)", (item["word"], item["definition"], item["sentence"], item["tip"], item["tag"], json.dumps({k: "imported" for k in ["definition", "sentence", "tip"] if item[k]}), original["created"], original["updated"], original["due"], original["stage"], status))
                db.execute("UPDATE words SET audio_flagged=?,audio_url=? WHERE id=?", (original.get("audio_flagged", 0), original.get("audio_url", ""), cur.lastrowid))
                db.execute("UPDATE words SET audio_urls=? WHERE id=?", (json.dumps(original.get("audio_urls", {})), cur.lastrowid))
                db.execute("UPDATE words SET meaning_flagged=?,distractors=? WHERE id=?", (original.get("meaning_flagged", 0), json.dumps(original.get("distractors", [])), cur.lastrowid))
                id_map[original["id"]] = cur.lastrowid
                added += 1
            for a in attempts:
                if a["word_id"] in id_map:
                    db.execute("INSERT INTO attempts (word_id,answer,correct,mode,hinted,elapsed_ms,created) VALUES (?,?,?,?,?,?,?)", (id_map[a["word_id"]], a["answer"], a["correct"], a["mode"], a["hinted"], a["elapsed_ms"], a["created"]))
        return {"added": added, "skipped": len(words) - added}
