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
