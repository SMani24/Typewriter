"""Local handoff contracts; never touch a real Anki collection or notebook."""
import json
import os
import re
import socket
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import requests

from typewriter.ankiautomata import AnkiAutomata
from typewriter.web import create_app

HEALTH = {"app": "ankiautomata", "api_version": 1, "capabilities": ["lookup", "sentence", "activate"]}
ROUTE = "/api/integrations/ankiautomata/lookup"


class Peer(BaseHTTPRequestHandler):
    def reply(self, status, content):
        self.send_response(status)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Location", "/redirect-target")
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self):
        self.server.visits.append(self.path)
        self.reply(self.server.health_status, self.server.health)

    def do_POST(self):
        self.server.visits.append(self.path)
        content = self.rfile.read(int(self.headers["Content-Length"]))
        self.server.payloads.append(content)
        self.server.content_types.append(self.headers["Content-Type"])
        self.reply(self.server.lookup_status, self.server.ack)

    def log_message(self, *_):
        pass


class AnkiAutomataTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        path = Path(temporary.name)
        self.app = create_app(path / "notebook", path / "no-keys", background=False)
        self.client = self.app.test_client()
        self.store = self.app.extensions["store"]
        token = re.search(r'name="typewriter-token" content="([^"]+)"', self.client.get("/").text).group(1)
        self.headers = {"X-Typewriter-Token": token, "Origin": "http://localhost"}
        self.peer = ThreadingHTTPServer(("127.0.0.1", 0), Peer)
        self.peer.health = json.dumps(HEALTH).encode()
        self.peer.health_status = self.peer.lookup_status = 200
        self.peer.ack = b"Lookup queued"
        self.peer.visits, self.peer.payloads, self.peer.content_types = [], [], []
        thread = threading.Thread(target=self.peer.serve_forever, kwargs={"poll_interval": .01}, daemon=True)
        thread.start()
        def cleanup():
            self.peer.shutdown()
            self.peer.server_close()
            thread.join(timeout=2)
        self.addCleanup(cleanup)
        self.integration = self.app.extensions["ankiautomata"]
        self.integration.address = f"http://127.0.0.1:{self.peer.server_port}"
        self.word_id = self.store.add_words([{"word": "necessary", "definition": "Required.", "sentence": "It is necessary.", "tip": "One c, two s."}])["added"][0]

    def send(self, data):
        return self.client.post(ROUTE, json=data, headers=self.headers)

    def snapshot(self):
        data = self.store.export()
        data.pop("exported")
        return data

    def test_saved_handoff_preserves_notebook_history_and_both_schedulers(self):
        self.store.attempt(self.word_id, {"answer": "neccessary"})
        before, settings = self.snapshot(), self.store.settings(private=True)
        for _ in range(2):
            result = self.send({"word_id": self.word_id})
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.json, {"message": "Opened in AnkiAutomata. Review the card there."})
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.store.settings(private=True), settings)
        self.assertEqual(self.peer.visits, ["/health", "/lookup"] * 2)
        self.assertEqual(json.loads(self.peer.payloads[0]), {"text": "necessary", "sentence": "It is necessary."})
        self.assertEqual(self.peer.content_types, ["application/json; charset=utf-8"] * 2)

    def test_draft_unicode_quotes_and_shell_syntax_remain_data(self):
        sentence = 'It is necessary: café, “quotes”, \'apostrophes\', $(touch /tmp/never) ; `echo nope` & <tag>.'
        before = self.snapshot()
        with patch("subprocess.Popen") as spawn:
            result = self.send({"word": "  Necessary  ", "sentence": sentence})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(json.loads(self.peer.payloads[0]), {"text": "necessary", "sentence": sentence})
        self.assertIn("café".encode(), self.peer.payloads[0])
        self.assertEqual(self.snapshot(), before)
        spawn.assert_not_called()

    def test_empty_or_missing_draft_sentence_always_clears_old_peer_context(self):
        for data in [{"word": "necessary", "sentence": ""}, {"word": "necessary"}, {"word_id": self.word_id}]:
            if "word_id" in data:
                self.store.edit_word(self.word_id, {"sentence": ""})
            self.assertEqual(self.send(data).status_code, 200)
            self.assertEqual(json.loads(self.peer.payloads[-1])["sentence"], "")

    def test_auth_and_origin_checks_precede_any_peer_request(self):
        for headers in [{}, {"X-Typewriter-Token": "wrong"}, {**self.headers, "Origin": "https://foreign.example"}, {**self.headers, "Sec-Fetch-Site": "cross-site"}]:
            self.assertEqual(self.client.post(ROUTE, json={"word_id": self.word_id}, headers=headers).status_code, 403)
        self.assertEqual(self.peer.visits, [])

    def test_editor_validation_and_ambiguous_identifiers_never_send(self):
        cases = [None, [], {}, {"word_id": True}, {"word_id": "1"}, {"word_id": -1},
                 {"word_id": self.word_id, "word": "necessary"}, {"word_id": self.word_id, "sentence": ""},
                 {"word": "bad;command"}, {"word": "a" * 81}, {"word": "necessary", "sentence": None},
                 {"word": "necessary", "sentence": 5}, {"word": "necessary", "sentence": "a" * 2001},
                 {"word": "necessary", "sentence": "An unrelated example."}]
        for data in cases:
            with self.subTest(data=type(data).__name__):
                result = self.client.post(ROUTE, data=json.dumps(data), content_type="application/json", headers=self.headers)
                self.assertEqual(result.status_code, 400)
        self.assertEqual(self.send({"word_id": 999999}).status_code, 404)
        self.assertEqual(self.peer.visits, [])

    def test_utf8_wire_size_boundary_is_checked_before_connecting(self):
        # More UTF-8 bytes than characters, still within the editor's 2,000-char limit.
        prefix = "necessary "
        base = len(json.dumps({"text": "necessary", "sentence": prefix}, ensure_ascii=False, separators=(",", ":")).encode())
        repeats, remaining = divmod(4096 - base, 3)
        sentence = prefix + "界" * repeats + "x" * remaining
        self.assertLess(len(sentence), 2000)
        self.assertEqual(self.send({"word": "necessary", "sentence": sentence}).status_code, 200)
        self.assertEqual(len(self.peer.payloads[-1]), 4096)
        before = list(self.peer.visits)
        result = self.send({"word": "necessary", "sentence": sentence + "x"})
        self.assertEqual(result.status_code, 413)
        self.assertIn("Shorten", result.json["error"])
        self.assertEqual(self.peer.visits, before)

    def test_wrong_app_protocol_or_malformed_health_is_not_sent_a_word(self):
        for health in [None, [], {**HEALTH, "app": "other"}, {**HEALTH, "api_version": 2},
                       {**HEALTH, "api_version": True}, {**HEALTH, "capabilities": ["lookup"]},
                       {**HEALTH, "capabilities": "lookup sentence activate"}]:
            self.peer.health = json.dumps(health).encode()
            self.assertEqual(self.send({"word_id": self.word_id}).status_code, 502)
        for content in [b"not JSON", b"x" * 4097]:
            self.peer.health = content
            self.assertEqual(self.send({"word_id": self.word_id}).status_code, 502)
        self.assertEqual(self.peer.payloads, [])

    def test_health_redirect_or_error_is_not_followed(self):
        for status in (301, 302, 307, 404, 500):
            self.peer.health_status = status
            self.assertEqual(self.send({"word_id": self.word_id}).status_code, 502)
        self.assertEqual(self.peer.visits, ["/health"] * 5)

    def test_lookup_errors_are_useful_sanitized_and_preserve_data(self):
        before = self.snapshot()
        canary = "PRIVATE_PEER_ERROR_DO_NOT_EXPOSE"
        self.peer.ack = canary.encode()
        for status, expected, phrase in [(400, 502, "could not accept"), (413, 413, "Shorten"), (429, 429, "queue is full"), (500, 502, "Check its window"), (302, 502, "Check its window")]:
            self.peer.lookup_status = status
            response = self.send({"word_id": self.word_id})
            self.assertEqual(response.status_code, expected)
            self.assertIn(phrase, response.json["error"])
            self.assertNotIn(canary, response.text)
        self.assertEqual(self.snapshot(), before)
        self.assertNotIn(canary, self.client.get("/api/logs/export").text)
        self.assertNotIn("/redirect-target", self.peer.visits)

    def test_wrong_or_oversized_ack_is_not_reported_as_success(self):
        for ack in (b"Added to Anki", b"", b"Lookup queued" + b" " * 200):
            self.peer.ack = ack
            self.assertEqual(self.send({"word_id": self.word_id}).status_code, 502)

    def test_closed_peer_explains_starting_and_retrying(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        self.integration.address = f"http://127.0.0.1:{port}"
        response = self.send({"word_id": self.word_id})
        self.assertEqual(response.status_code, 503)
        self.assertIn("Start it", response.json["error"])
        self.assertIn("retry", response.json["error"])

    def test_timeouts_are_bounded_and_post_is_never_automatically_retried(self):
        original = requests.Session.request
        for failing in ("GET", "POST"):
            calls = []
            def request(session, method, url, **kwargs):
                calls.append(method)
                self.assertEqual(kwargs["timeout"], (2, 4))
                self.assertFalse(kwargs["allow_redirects"])
                if method.upper() == failing:
                    raise requests.Timeout("private request details")
                return original(session, method, url, **kwargs)
            with patch.object(requests.Session, "request", request):
                response = self.send({"word_id": self.word_id})
            self.assertEqual(response.status_code, 504)
            self.assertEqual(len(calls), 1 if failing == "GET" else 2)
            self.assertNotIn("private request details", response.text)
            if failing == "POST":
                self.assertIn("may already be queued", response.json["error"])

    def test_local_requests_ignore_environment_and_app_proxy(self):
        self.store.save_settings({"proxy_enabled": True, "proxy_host": "invalid.example", "proxy_port": 1})
        original = requests.Session.request
        def request(session, method, url, **kwargs):
            self.assertFalse(session.trust_env)
            self.assertEqual(session.proxies, {})
            self.assertTrue(url.startswith(self.integration.address + "/"))
            return original(session, method, url, **kwargs)
        with patch.dict(os.environ, {"HTTP_PROXY": "http://invalid.example:1", "ALL_PROXY": "socks5://invalid.example:1", "NO_PROXY": ""}), patch.object(requests.Session, "request", request):
            self.assertEqual(self.send({"word_id": self.word_id}).status_code, 200)

    def test_duplicate_imports_preserve_existing_clues_reviews_and_due_dates(self):
        self.store.attempt(self.word_id, {"answer": "necessary"})
        before = self.snapshot()
        for _ in range(2):
            response = self.client.post("/api/words", json={"words": [{"word": "necessary", "definition": "Different.", "sentence": "A necessary change.", "tag": "AnkiAutomata"}]}, headers=self.headers)
            self.assertEqual(response.status_code, 201)
            self.assertEqual(response.json, {"added": [], "duplicates": ["necessary"]})
        self.assertEqual(self.snapshot(), before)

    def test_client_cannot_be_configured_with_remote_url_or_bad_port(self):
        for port in (True, "http://remote.example", 0, -1, 65536):
            with self.assertRaises(ValueError):
                AnkiAutomata(port)
        self.assertEqual(AnkiAutomata().address, "http://127.0.0.1:24536")
