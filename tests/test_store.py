import tempfile
import unittest
from pathlib import Path
from typewriter.store import Store, blank_sentence


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = Store(Path(self.directory.name) / "test.db")
        self.id = self.store.add_words([{"word": "necessary"}])["added"][0]

    def test_drills_and_hints_do_not_inflate_recall(self):
        for _ in range(10):
            self.store.attempt(self.id, {"answer": "necessary", "mode": "drill"})
        self.store.attempt(self.id, {"answer": "necessary", "mode": "review", "hinted": True})
        word = self.store.word(self.id)
        self.assertEqual((word["stage"], word["reviews"], word["drills"]), (0, 0, 10))

    def test_only_one_promotion_per_day(self):
        for _ in range(4):
            self.store.attempt(self.id, {"answer": "Necessary", "mode": "review"})
        self.assertEqual(self.store.word(self.id)["stage"], 1)
        self.store.attempt(self.id, {"answer": "neccessary"})
        self.assertEqual(self.store.word(self.id)["stage"], 0)

    def test_generation_preserves_manual_edits(self):
        self.store.edit_word(self.id, {"definition": "My own meaning"})
        self.store.enrich_word(self.id, {"definition": "Generated meaning", "sentence": "This is necessary.", "tip": "One c, two s."}, "Gemini")
        self.assertEqual(self.store.word(self.id)["definition"], "My own meaning")
        self.assertEqual(self.store.word(self.id)["status"], "ready")

    def test_bad_example_is_not_accepted(self):
        with self.assertRaises(ValueError):
            self.store.edit_word(self.id, {"sentence": "It was unnecessarily long."})
        self.assertEqual(blank_sentence("necessary", "Necessary changes are necessary."), "________ changes are ________.")

    def test_backup_roundtrip_and_repeated_import(self):
        self.store.attempt(self.id, {"answer": "necessary"})
        backup = self.store.export()
        other = Store(Path(self.directory.name) / "other.db")
        self.assertEqual(other.import_backup(backup)["added"], 1)
        self.assertEqual(other.progress()["reviews"], 1)
        self.assertEqual(other.import_backup(backup)["added"], 0)
        self.assertEqual(other.progress()["reviews"], 1)

    def test_proxy_settings_hide_password(self):
        self.store.save_settings({"proxy_enabled": True, "proxy_password": "local-secret"})
        self.assertEqual(self.store.settings()["proxy_password"], "")
        self.store.save_settings({"proxy_password": ""})
        self.assertEqual(self.store.settings(private=True)["proxy_password"], "local-secret")

    def test_invalid_bulk_is_atomic(self):
        with self.assertRaises(ValueError):
            self.store.add_words([{"word": "different"}, {"word": "<script>"}])
        self.assertEqual(len(self.store.list_words()), 1)

    def test_source_labels_survive_unchanged_edits(self):
        self.store.enrich_word(self.id, {"definition": "Needed", "sentence": "This is necessary.", "tip": "One c, two s."}, "Gemini")
        self.store.edit_word(self.id, {"definition": "Needed", "sentence": "This is necessary.", "tip": "My own spelling tip"})
        sources = self.store.word(self.id)["sources"]
        self.assertEqual(sources["definition"], "Gemini")
        self.assertEqual(sources["tip"], "manual")

    def test_practice_preferences_persist_and_require_one_mode(self):
        self.store.save_settings({"review_enabled": False})
        self.assertFalse(Store(self.store.path).settings()["review_enabled"])
        with self.assertRaises(ValueError):
            self.store.save_settings({"drill_enabled": False})
        self.assertTrue(self.store.settings()["drill_enabled"])

    def test_logs_are_bounded_and_not_in_notebook_backups(self):
        with self.store.db() as db:
            db.executemany("INSERT INTO app_log (created,level,message) VALUES (?,?,?)", [("2026-01-01", "info", f"Event {i}") for i in range(502)])
        self.store.log("info", "Latest event")
        self.assertEqual(len(self.store.logs(1000)), 500)
        self.assertNotIn("logs", self.store.export())
