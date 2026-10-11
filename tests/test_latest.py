import tempfile
import unittest
from pathlib import Path
from typewriter.store import Store
from typewriter.dictionary import Dictionary


class LatestTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = Store(Path(self.directory.name) / "test.db")
        self.id = self.store.add_words([{"word": "color"}])["added"][0]

    def test_alternative_accent_does_not_change_global_preference(self):
        dictionary = Dictionary(self.store, None)
        dictionary.lookup = lambda word, **kwargs: {"audio": {"us": "https://dictionary.cambridge.org/us.mp3"}}
        result = dictionary.pronunciation(self.id)
        self.assertEqual(result["alternative"], "us")
        self.assertEqual(self.store.word(self.id)["pronunciation_accent"], "")
        result = dictionary.pronunciation(self.id, choose_alternative=True)
        self.assertEqual(result["selected"], "us")
        self.assertEqual(self.store.settings()["pronunciation_accent"], "uk")
        self.assertFalse(self.store.word(self.id)["audio_eligible"])
        self.store.set_audio(self.id, verified=True, flagged=True)
        dictionary.pronunciation(self.id, choose_alternative=True)
        self.assertTrue(self.store.word(self.id)["audio_flagged"])
        restored = Store(Path(self.directory.name) / "backup.db")
        restored.import_backup(self.store.export())
        self.assertEqual(restored.list_words()[0]["pronunciation_accent"], "us")

    def test_uploaded_audio_is_preserved_without_a_lookup(self):
        self.store.set_audio(self.id, file="a" * 32 + ".wav", verified=True)
        dictionary = Dictionary(self.store, None)
        dictionary.lookup = lambda *args, **kwargs: self.fail("Uploaded recordings need no lookup")
        self.assertTrue(dictionary.pronunciation(self.id, choose_alternative=True)["uploaded"])
        self.assertTrue(self.store.word(self.id)["audio_eligible"])

    def test_rename_resets_learning_without_erasing_history(self):
        self.store.attempt(self.id, {"answer": "color", "mode": "review"})
        self.store.set_audio(self.id, file="a" * 32 + ".wav", verified=True)
        before = self.store.export()["attempts"]
        word = self.store.edit_word(self.id, {"word": "colour", "sentence": "The colour is blue."})
        self.assertEqual((word["word"], word["stage"], word["reviews"], word["recent_reviews"]), ("colour", 0, 0, 0))
        self.assertTrue(word["is_due"])
        self.assertFalse(word["audio_eligible"])
        self.assertEqual(self.store.export()["attempts"], before)
        self.assertEqual(self.store.progress()["reviews"], 1)
        self.assertEqual(self.store.attempt(self.id, {"answer": "colour", "mode": "review"})["word"]["stage"], 1)
        restored = Store(Path(self.directory.name) / "renamed.db")
        restored.import_backup(self.store.export())
        self.assertEqual(restored.list_words()[0]["reviews"], 1)
        self.assertEqual(restored.progress()["reviews"], 2)

    def test_rename_to_existing_word_is_atomic(self):
        self.store.add_words([{"word": "colour"}])
        before = self.store.export()
        with self.assertRaisesRegex(ValueError, "already in your notebook"):
            self.store.edit_word(self.id, {"word": "colour", "definition": "Changed"})
        self.assertEqual(self.store.export()["words"], before["words"])

    def test_volume_is_saved_and_validated(self):
        for value in (0, 35, 100):
            self.store.save_settings({"audio_volume": value})
            self.assertEqual(Store(self.store.path).settings()["audio_volume"], value)
        for value in (-1, 101, True, "35"):
            with self.assertRaises(ValueError):
                self.store.save_settings({"audio_volume": value})
