"""Cambridge lookup adapted from AnkiAutomata's sense-based parser."""
import json
from urllib.parse import quote, urljoin, urlparse
from bs4 import BeautifulSoup
from .store import clean_word, contains_word

USER_AGENT = "Mozilla/5.0 (compatible; Typewriter personal dictionary lookup)"


class Dictionary:
    def __init__(self, store, network):
        self.store, self.network = store, network

    def lookup(self, word):
        word = clean_word(word)
        cache_key = "cambridge:" + word
        with self.store.db() as db:
            cached = db.execute("SELECT value FROM cache WHERE name=?", (cache_key,)).fetchone()
        if cached:
            return {**json.loads(cached["value"]), "cached": True}
        url = "https://dictionary.cambridge.org/dictionary/english/" + quote(word.replace(" ", "-"))
        response = self.network.request("GET", url, headers={"User-Agent": USER_AGENT})
        if response.status_code != 200:
            raise ValueError("Cambridge lookup is unavailable. You can enter the meaning manually or use Gemini.")
        result = self.parse(word, response.text, url)
        if not result["senses"]:
            raise ValueError("No dictionary entry found. Try manual entry or Gemini.")
        with self.store.db() as db:
            db.execute("INSERT OR REPLACE INTO cache VALUES (?,?)", (cache_key, json.dumps(result)))
        return {**result, "cached": False}

    @staticmethod
    def parse(word, html, url):
        soup = BeautifulSoup(html, "html.parser")
        senses, seen = [], set()
        for entry in soup.select(".entry-body__el"):
            pos = entry.select_one(".pos.dpos")
            for block in entry.select(".def-block.ddef_block, .ddef_block"):
                definition = block.select_one(".def.ddef_d")
                if not definition:
                    continue
                text = definition.get_text(" ", strip=True).rstrip(" :")
                if not text or text.lower() in seen:
                    continue
                seen.add(text.lower())
                parent = block.find_parent(class_="dsense")
                guide = parent.select_one(".guideword, .dsense_gw") if parent else None
                examples = [e.get_text(" ", strip=True) for e in block.select(".eg.deg")]
                senses.append({"definition": text, "pos": pos.get_text(strip=True) if pos else "", "guideword": guide.get_text(strip=True).strip("()") if guide else "", "examples": [e for e in examples if contains_word(word, e)]})
        audio = {}
        for region in ["uk", "us"]:
            src = soup.select_one(f'.{region} source[type="audio/mpeg"]')
            candidate = urljoin("https://dictionary.cambridge.org", src.get("src", "")) if src else ""
            if urlparse(candidate).netloc == "dictionary.cambridge.org":
                audio[region] = candidate
        return {"word": word, "senses": senses, "audio": audio, "source_url": url}

    def audio(self, word_id):
        word = self.store.word(word_id)
        if not word:
            raise KeyError("Word not found.")
        url = word["audio_url"]
        if not url:
            lookup = self.lookup(word["word"])
            url = lookup["audio"].get("uk") or lookup["audio"].get("us")
        if not url or urlparse(url).netloc != "dictionary.cambridge.org":
            raise ValueError("No pronunciation available for this word.")
        name = "audio:" + url
        directory = self.store.path.parent / "audio"
        import hashlib
        path = directory / (hashlib.sha256(name.encode()).hexdigest() + ".mp3")
        if not path.exists():
            referer = "https://dictionary.cambridge.org/dictionary/english/" + quote(word["word"].replace(" ", "-"))
            response = self.network.request("GET", url, stream=True, headers={"User-Agent": USER_AGENT, "Referer": referer})
            try:
                if response.status_code != 200:
                    raise ValueError("Pronunciation is unavailable right now.")
                chunks, size = [], 0
                for chunk in response.iter_content(65536):
                    size += len(chunk)
                    if size > 5 * 1024 * 1024:
                        raise ValueError("Pronunciation file is too large.")
                    chunks.append(chunk)
                directory.mkdir(exist_ok=True)
                path.write_bytes(b"".join(chunks))
            finally:
                response.close()
        return path
