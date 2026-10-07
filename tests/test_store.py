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

    def test_meaning_quizzes_keep_spelling_stage_and_statistics_separate(self):
        self.store.edit_word(self.id, {'definition':'Required for a purpose.'})
        other=self.store.add_words([{'word':'different','definition':'Not the same.'}])['added'][0]
        self.assertFalse(self.store.attempt(self.id,{'mode':'meaning','answer':str(other)})['correct'])
        self.assertTrue(self.store.attempt(self.id,{'mode':'meaning','answer':str(self.id)})['correct'])
        self.assertEqual(self.store.word(self.id)['stage'],0)
        self.assertEqual(self.store.progress()['reviews'],0)
        self.assertEqual(self.store.progress()['meanings'],2)
        self.assertEqual(self.store.progress()['meanings_correct'],1)
        other_store=Store(Path(self.directory.name)/'meaning-backup.db')
        other_store.import_backup(self.store.export())
        self.assertEqual(other_store.progress()['meanings_correct'],1)

    def test_audio_flag_excludes_even_a_verified_recording(self):
        self.store.edit_word(self.id,{'source':'Cambridge','audio_url':'https://dictionary.cambridge.org/test.mp3'})
        self.store.set_audio(self.id,verified=True)
        self.assertTrue(self.store.word(self.id)['audio_eligible'])
        self.store.set_audio(self.id,flagged=True)
        self.assertFalse(self.store.word(self.id)['audio_eligible'])

    def test_review_exercises_cannot_all_be_disabled(self):
        with self.assertRaises(ValueError):
            self.store.save_settings({k:False for k in ('sentence_enabled','definition_enabled','audio_enabled','meaning_enabled')})

    def test_audio_flags_survive_backup_without_implicitly_trusting_recordings(self):
        self.store.edit_word(self.id,{'source':'Cambridge','audio_url':'https://dictionary.cambridge.org/audio.mp3'})
        self.store.set_audio(self.id,flagged=True,verified=True)
        other=Store(Path(self.directory.name)/'audio-backup.db')
        other.import_backup(self.store.export())
        word=other.list_words()[0]
        self.assertTrue(word['audio_flagged'])
        self.assertFalse(word['audio_verified'])
        self.assertFalse(word['audio_eligible'])

    def test_audio_schema_upgrade_preserves_existing_word_and_review_history(self):
        self.store.attempt(self.id,{'answer':'necessary'})
        before=self.store.word(self.id)
        with self.store.db() as db:
            for column in ('audio_file','audio_verified','audio_flagged'):
                db.execute(f'ALTER TABLE words DROP COLUMN {column}')
        migrated=Store(self.store.path)
        after=migrated.word(self.id)
        for field in ('word','created','due','stage','reviews'):
            self.assertEqual(after[field],before[field])
        self.assertFalse(after['audio_eligible'])
