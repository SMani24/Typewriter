import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from typewriter.store import Store
from typewriter.network import Network, NetworkError
from typewriter.enrichment import Enrichment, KeyPool, parse_keys
from typewriter.dictionary import Dictionary


class NetworkTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        directory = Path(self.directory.name)
        self.store = Store(directory / "test.db")
        self.network = Network(self.store)
        self.keys = directory / "keys.txt"
        self.keys.write_text("first-fake-key-for-unit-tests\nsecond-fake-key-for-unit-tests\n")
        self.enrichment = Enrichment(self.store, self.network, self.keys)
        self.enrichment.pool.pace = Mock()

    def test_proxy_is_explicit_for_http_and_https(self):
        self.store.save_settings({"proxy_enabled": True, "proxy_host": "localhost", "proxy_port": 1234, "proxy_username": "a@b", "proxy_password": "p:q"})
        session = self.network.session()
        self.assertFalse(session.trust_env)
        self.assertEqual(session.proxies["https"], "socks5h://a%40b:p%3Aq@localhost:1234")
        self.assertEqual(session.proxies["http"], session.proxies["https"])
        self.store.save_settings({"proxy_enabled": False})
        self.assertEqual(self.network.session().proxies, {})

    def test_rotation_and_persistent_budget(self):
        self.store.save_settings({"daily_budget": 1})
        pool = self.enrichment.pool
        first = pool.reserve(set())[1]
        second = pool.reserve(set())[1]
        self.assertNotEqual(first, second)
        restarted = KeyPool(self.store, self.keys)
        with self.assertRaises(ValueError):
            restarted.reserve(set())

    def test_rate_limit_rotates_to_other_key(self):
        word_id = self.store.add_words([{"word": "necessary"}])["added"][0]
        limited = Mock(status_code=429, text='quota RequestsPerDay exceeded')
        good = Mock(status_code=200)
        generated = {"words": [{"word": "necessary", "definition": "Needed", "sentence": "Careful planning is necessary.", "tip": "One c and two s."}]}
        good.json.return_value = {"candidates": [{"content": {"parts": [{"text": json.dumps(generated)}]}}]}
        with patch.object(self.network, "request", side_effect=[limited, good]) as request:
            content = self.enrichment.generate([self.store.word(word_id)])
        self.assertIn("necessary", content)
        self.assertNotEqual(request.call_args_list[0].kwargs["headers"], request.call_args_list[1].kwargs["headers"])
        self.assertEqual(self.enrichment.pool.snapshot()["keys"][0]["reason"], "Daily provider quota")

    def test_one_request_prepares_multiple_words(self):
        ids = self.store.add_words([{"word": "necessary"}, {"word": "different"}])["added"]
        response = Mock(status_code=200)
        response.json.return_value = {"candidates": [{"content": {"parts": [{"text": json.dumps({"words": [{"word": "necessary", "definition": "Needed", "sentence": "This is necessary.", "tip": "One c."}, {"word": "different", "definition": "Not the same", "sentence": "They have different opinions.", "tip": "Two f letters."}]})}]}}]}
        with patch.object(self.network, "request", return_value=response) as request:
            self.enrichment.run(ids)
        self.assertEqual(request.call_count, 1)
        self.assertTrue(all(w["status"] == "ready" for w in self.store.list_words()))

    def test_failed_batch_keeps_words_and_sanitizes_network_errors(self):
        word_id = self.store.add_words([{"word": "necessary"}])["added"][0]
        with patch.object(self.network, "request", side_effect=NetworkError("Could not connect.")):
            self.enrichment.run([word_id])
        self.assertEqual(self.store.word(word_id)["status"], "pending")
        self.assertFalse(self.enrichment.snapshot()["busy"])

    def test_dictionary_filters_inflections(self):
        html = '<div class="entry-body__el"><span class="pos dpos">adjective</span><div class="def-block ddef_block"><div class="def ddef_d">needed:</div><span class="eg deg">It is necessary.</span><span class="eg deg">Unnecessarily long.</span></div></div>'
        result = Dictionary.parse("necessary", html, "https://dictionary.cambridge.org/")
        self.assertEqual(result["senses"][0]["examples"], ["It is necessary."])

    def test_no_secret_material_in_status(self):
        snapshot = json.dumps(self.enrichment.snapshot())
        for key in parse_keys(self.keys.read_text()):
            self.assertNotIn(key, snapshot)

    def test_auto_waits_for_threshold(self):
        self.store.add_words([{"word": "necessary"}])
        self.enrichment.auto_schedule()
        self.assertIsNone(self.enrichment.timer)
