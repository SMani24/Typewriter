"""Explicit word handoff to AnkiAutomata's loopback-only GUI queue."""
import json

import requests


class AnkiAutomataError(RuntimeError):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


class AnkiAutomata:
    def __init__(self, port=24536):
        # Port injection is for isolated tests; neither requests nor settings can
        # select a host, URL, proxy, or executable.
        if type(port) is not int or not 1 <= port <= 65535:
            raise ValueError("Choose a valid local AnkiAutomata port.")
        self.address = f"http://127.0.0.1:{port}"

    @staticmethod
    def read(response, limit):
        content = bytearray()
        for chunk in response.iter_content(chunk_size=512):
            content.extend(chunk)
            if len(content) > limit:
                raise AnkiAutomataError("Unexpected response from the local AnkiAutomata port. Check that AnkiAutomata is running, then retry.")
        return bytes(content)

    def lookup(self, word, sentence):
        try:
            payload = json.dumps({"text": word, "sentence": sentence}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        except UnicodeError:
            raise ValueError("The word and sentence must contain valid Unicode text.") from None
        if len(payload) > 4096:
            raise AnkiAutomataError("The word and sentence exceed AnkiAutomata's 4 KB limit. Shorten the sentence and retry; nothing has been sent.", 413)

        queued = False
        try:
            with requests.Session() as session:
                # This local handoff must bypass both Typewriter's personal
                # proxy and shell proxy/netrc settings. Never follow redirects.
                session.trust_env = False
                options = {"timeout": (2, 4), "allow_redirects": False, "stream": True}
                with session.get(self.address + "/health", **options) as response:
                    if response.status_code != 200:
                        raise AnkiAutomataError("The local port did not identify AnkiAutomata. Start or update AnkiAutomata, then retry.")
                    try:
                        health = json.loads(self.read(response, 4096))
                    except (ValueError, UnicodeError):
                        health = None
                    if (not isinstance(health, dict) or health.get("app") != "ankiautomata"
                            or type(health.get("api_version")) is not int or health["api_version"] != 1
                            or not isinstance(health.get("capabilities"), list)
                            or not all(item in health["capabilities"] for item in ("lookup", "sentence", "activate"))):
                        raise AnkiAutomataError("The local port is not a compatible AnkiAutomata app. Start or update AnkiAutomata, then retry.")
                queued = True  # Once POST starts, a missing reply is ambiguous.
                with session.post(self.address + "/lookup", data=payload,
                                  headers={"Content-Type": "application/json; charset=utf-8"}, **options) as response:
                    if response.status_code == 429:
                        raise AnkiAutomataError("AnkiAutomata's lookup queue is full. Let it finish the queued lookups, then retry.", 429)
                    if response.status_code == 413:
                        raise AnkiAutomataError("AnkiAutomata rejected the request size. Shorten the sentence and retry.", 413)
                    if response.status_code == 400:
                        raise AnkiAutomataError("AnkiAutomata could not accept this word and sentence. Check the fields or update AnkiAutomata, then retry.")
                    if response.status_code != 200 or self.read(response, 128).strip() != b"Lookup queued":
                        raise AnkiAutomataError("AnkiAutomata did not confirm the lookup. Check its window before retrying.")
        except requests.Timeout:
            message = ("AnkiAutomata did not respond in time. Check its window before retrying; the lookup may already be queued."
                       if queued else "AnkiAutomata's health check timed out. Open the app and retry shortly.")
            raise AnkiAutomataError(message, 504) from None
        except requests.RequestException:
            # Transport errors can contain URLs or request details. Do not log
            # or return them, and do not retry an ambiguous POST automatically.
            raise AnkiAutomataError("Could not reach AnkiAutomata. Start it from your application launcher or run main.py with its own Python environment, then retry. If it was already open, check its window first.", 503) from None
        return {"message": "Opened in AnkiAutomata. Review the card there."}
