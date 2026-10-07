import tempfile
import unittest
from pathlib import Path
from typewriter.web import create_app


class WebTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        directory = Path(self.directory.name)
        self.app = create_app(directory, directory / "keys.txt", background=False)
        self.client = self.app.test_client()
        # The test requests obtain the same per-process token as the browser page.
        with self.app.test_request_context("/"):
            html = self.app.view_functions["home"]()
        import re
        self.token = re.search(r'name="typewriter-token" content="([^"]+)"', html).group(1)
        self.headers = {"X-Typewriter-Token": self.token}

    def test_end_to_end_local_practice(self):
        response = self.client.post("/api/words", json={"words": [{"word": "necessary"}]}, headers=self.headers)
        self.assertEqual(response.status_code, 201)
        word_id = response.json["added"][0]
        response = self.client.post(f"/api/words/{word_id}/attempts", json={"answer": "neccessary"}, headers=self.headers)
        self.assertFalse(response.json["correct"])
        backup = self.client.get("/api/export").json
        self.assertEqual(len(backup["attempts"]), 1)
        self.assertNotIn("settings", backup)

    def test_external_site_cannot_change_or_read_data(self):
        response = self.client.post("/api/words", json={"words": [{"word": "different"}]})
        self.assertEqual(response.status_code, 403)
        response = self.client.get("/api/state", headers={"Origin": "https://other.example"})
        self.assertEqual(response.status_code, 403)

    def test_api_keys_are_never_returned(self):
        secret = "fake-secret-key-for-browser-test"
        response = self.client.put("/api/keys", json={"keys": secret}, headers=self.headers)
        self.assertEqual(response.json, {"count": 1})
        self.assertNotIn(secret, self.client.get("/api/state").text)
        self.assertNotIn(secret, self.client.get("/api/export").text)
        self.assertEqual(self.client.get("/api_keys.txt").status_code, 404)

    def test_log_download_only_exposes_curated_events(self):
        self.app.extensions["store"].log("info", "Preparation started for 5 words.")
        response = self.client.get("/api/logs/export")
        self.assertEqual(response.status_code, 200)
        self.assertIn("Preparation started for 5 words.", response.text)
        self.assertIn("typewriter-log.txt", response.headers["Content-Disposition"])
        self.assertEqual(len(self.client.get("/api/state").json["logs"]), 1)
