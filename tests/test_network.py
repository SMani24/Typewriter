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
        self.enrichment.catalog.validate = Mock()

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

    def test_audio_uses_network_route_and_is_cached(self):
        word_id = self.store.add_words([{"word": "necessary"}])["added"][0]
        self.store.edit_word(word_id, {"source": "Cambridge", "audio_url": "https://dictionary.cambridge.org/media/example.mp3"})
        response = Mock(status_code=200)
        response.iter_content.return_value = [b'ID3sample']
        dictionary = Dictionary(self.store, self.network)
        with patch.object(self.network, 'request', return_value=response) as request:
            first = dictionary.audio(word_id)
            second = dictionary.audio(word_id)
        self.assertEqual(first.read_bytes(), b'ID3sample')
        self.assertEqual(first, second)
        self.assertEqual(request.call_count, 1)
        self.assertIn('User-Agent', request.call_args.kwargs['headers'])
        self.assertIn('Referer', request.call_args.kwargs['headers'])

    def test_no_secret_material_in_status(self):
        snapshot = json.dumps(self.enrichment.snapshot())
        for key in parse_keys(self.keys.read_text()):
            self.assertNotIn(key, snapshot)

    def test_auto_waits_for_threshold(self):
        self.store.add_words([{"word": "necessary"}])
        self.enrichment.auto_schedule()
        self.assertIsNone(self.enrichment.timer)

    def test_selected_batch_leaves_other_words_queued(self):
        ids = self.store.add_words([{"word": "necessary"}, {"word": "different"}])["added"]
        self.enrichment.generate = Mock(return_value={"necessary": {"definition": "Needed", "sentence": "This is necessary.", "tip": "One c, two s."}})
        self.enrichment.run([ids[0]])
        self.assertEqual(self.store.word(ids[0])["status"], "ready")
        self.assertEqual(self.store.word(ids[1])["status"], "pending")
        self.assertEqual(len(self.enrichment.generate.call_args.args[0]), 1)

    def test_day_reset_restores_budget(self):
        self.store.save_settings({"daily_budget": 1})
        pool = self.enrichment.pool
        pool.reserve(set())
        pool.reserve(set())
        with self.assertRaises(ValueError):
            pool.reserve(set())
        with patch('typewriter.enrichment.quota_day', return_value='2099-01-02'):
            self.assertTrue(pool.reserve(set())[0])

    def test_all_limited_keys_stop_without_looping(self):
        word_id = self.store.add_words([{"word": "necessary"}])["added"][0]
        response = Mock(status_code=429, text='RequestsPerDay exceeded')
        with patch.object(self.network, 'request', return_value=response) as request:
            self.enrichment.run([word_id])
        self.assertEqual(request.call_count, 2)
        self.assertFalse(self.enrichment.snapshot()["busy"])
        self.assertIn("cooling down", self.enrichment.snapshot()["error"])

    def test_partial_results_are_visible_and_survive_restart(self):
        ids = self.store.add_words([{"word": "necessary"}, {"word": "different"}])["added"]
        self.enrichment.generate = Mock(return_value={"necessary": {"definition": "Needed", "sentence": "It is necessary.", "tip": "One c."}})
        self.enrichment.run(ids)
        job = self.enrichment.snapshot()
        self.assertEqual((job["status"], job["done"], job["total"]), ("partial", 1, 2))
        self.assertIn("1 word", job["error"])
        restarted = Enrichment(self.store, self.network, self.keys)
        self.assertEqual(restarted.snapshot()["error"], job["error"])
        self.assertTrue(self.store.logs())

    def test_temporary_server_errors_retry_with_a_limit_and_budget(self):
        word_id = self.store.add_words([{"word": "necessary"}])["added"][0]
        response = Mock(status_code=503, text="secret provider body")
        with patch.object(self.network, "request", return_value=response) as request, patch("typewriter.enrichment.time.sleep"):
            self.enrichment.run([word_id])
        self.assertEqual(request.call_count, 3)
        self.assertEqual(self.enrichment.pool.snapshot()["requests_today"], 3)
        self.assertIn("HTTP 503 after 3 attempts", self.enrichment.snapshot()["error"])
        self.assertNotIn(response.text, json.dumps(self.store.logs()))
        for key in parse_keys(self.keys.read_text()):
            self.assertNotIn(key, json.dumps(self.store.logs()))

    def test_retry_can_recover_and_accept_capitalized_word(self):
        word_id = self.store.add_words([{"word": "necessary"}])["added"][0]
        busy = Mock(status_code=503)
        good = Mock(status_code=200)
        good.json.return_value = {"candidates": [{"content": {"parts": [{"text": json.dumps({"words": [{"word": "Necessary", "definition": "Needed", "sentence": "This is necessary.", "tip": "One c."}]})}]}}]}
        with patch.object(self.network, "request", side_effect=[busy, good]), patch("typewriter.enrichment.time.sleep"):
            self.enrichment.run([word_id])
        self.assertEqual(self.enrichment.snapshot()["status"], "completed")
        self.assertEqual(self.store.word(word_id)["status"], "ready")

    def test_interrupted_job_is_reported_after_restart(self):
        self.store.job_state({"id": "test-job", "status": "running", "busy": True, "message": "Preparing", "done": 0, "total": 1, "error": ""})
        restarted = Enrichment(self.store, self.network, self.keys)
        self.assertFalse(restarted.snapshot()["busy"])
        self.assertIn("interrupted", restarted.snapshot()["error"])

    def test_transport_logs_never_include_exception_credentials(self):
        import requests
        secret = "private-key-and-proxy-password"
        with patch("requests.Session.request", side_effect=requests.ReadTimeout(secret)):
            with self.assertRaisesRegex(NetworkError, "timed out"):
                self.network.request("GET", "https://example.test")
        with patch("requests.Session.request", side_effect=requests.ConnectionError(secret)):
            with self.assertRaises(NetworkError):
                self.network.request("GET", "https://example.test")
        self.assertNotIn(secret, json.dumps(self.store.logs()))

    def test_cambridge_audio_requires_exact_entry_headword(self):
        html='<div class="entry-body__el"><span class="hw dhw">high</span><div class="uk"><source type="audio/mpeg" src="/media/high.mp3"></div></div>'
        self.assertEqual(Dictionary.parse('highest',html,'https://dictionary.cambridge.org/dictionary/english/high')['audio'],{})
        self.assertEqual(Dictionary.parse('heighest',html,'https://dictionary.cambridge.org/dictionary/english/high')['audio'],{})
        mixed=html+'<div class="entry-body__el"><span class="hw dhw">highest</span><div class="uk"><source type="audio/mpeg" src="/media/highest.mp3"></div></div>'
        self.assertTrue(Dictionary.parse('highest',mixed,'https://dictionary.cambridge.org/')['audio']['uk'].endswith('/highest.mp3'))

    def test_offline_mode_never_schedules_or_starts_gemini(self):
        self.store.save_settings({'preparation_method':'offline'})
        self.store.add_words([{'word':w} for w in ('necessary','different','environment','highest','regular')])
        self.enrichment.auto_schedule()
        self.assertIsNone(self.enrichment.timer)
        with self.assertRaises(ValueError): self.enrichment.start()

    def test_switching_to_offline_stops_future_batches(self):
        self.store.save_settings({'batch_size':1})
        ids=self.store.add_words([{'word':'necessary'},{'word':'different'}])['added']
        def first_batch(words):
            self.store.save_settings({'preparation_method':'offline'})
            w=words[0]['word']
            return {w:{'definition':'Needed','sentence':f'This is {w}.','tip':'Notice each letter.'}}
        self.enrichment.generate=Mock(side_effect=first_batch)
        self.enrichment.run(ids)
        self.assertEqual(self.enrichment.generate.call_count,1)
        self.assertEqual(self.store.word(ids[0])['status'],'ready')
        self.assertEqual(self.store.word(ids[1])['status'],'pending')
        self.assertIn('another preparation method',self.enrichment.snapshot()['error'])
