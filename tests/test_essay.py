import tempfile
import unittest
from pathlib import Path

from typewriter.store import Store
from typewriter.spelling import check


class EssayTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = Store(Path(self.directory.name) / 'notebook.db')

    def test_draft_is_preserved_exactly_and_survives_reload(self):
        draft = {'title':'Practice', 'prompt':'Discuss both views.', 'body':'  A thought.\n\nAnother thought. 🙂\n', 'highlight':True, 'version':0}
        saved = self.store.save_essay(draft)
        self.assertEqual(saved['body'], draft['body'])
        self.assertEqual(Store(self.store.path).essay(), saved)
        self.assertEqual(self.store.progress()['reviews'], 0)

    def test_another_tab_cannot_overwrite_a_newer_saved_draft(self):
        self.store.save_essay({'body':'Newer writing', 'version':0})
        with self.assertRaisesRegex(ValueError, 'another tab'):
            self.store.save_essay({'body':'Older tab', 'version':0})
        self.assertEqual(self.store.essay()['body'], 'Newer writing')

    def test_invalid_drafts_never_partially_save(self):
        for data in [{'body':'x'*100001}, {'highlight':'false'}, {'title':[]}, {'prompt':'x'*4001}]:
            with self.assertRaises(ValueError):
                self.store.save_essay({**data, 'version':0})
        self.assertEqual(self.store.essay()['version'], 0)

    def test_backup_roundtrip_keeps_an_existing_draft(self):
        self.store.save_essay({'body':'My first essay.', 'highlight':True, 'version':0})
        restored = Store(Path(self.directory.name) / 'restored.db')
        self.assertTrue(restored.import_backup(self.store.export())['essay_imported'])
        self.assertEqual(restored.essay()['body'], 'My first essay.')
        self.assertTrue(restored.essay()['highlight'])
        restored.save_essay({**restored.essay(), 'body':'My newer essay.'})
        self.assertFalse(restored.import_backup(self.store.export())['essay_imported'])
        self.assertEqual(restored.essay()['body'], 'My newer essay.')
        old = self.store.export();del old['essay']
        restored.import_backup(old)
        self.assertEqual(restored.essay()['body'], 'My newer essay.')

    def test_invalid_essay_backup_does_not_import_words(self):
        self.store.add_words([{'word':'necessary'}])
        backup = self.store.export();backup['essay']['body'] = []
        restored = Store(Path(self.directory.name) / 'invalid.db')
        with self.assertRaises(ValueError):
            restored.import_backup(backup)
        self.assertEqual(restored.list_words(), [])

    def test_offline_spelling_accepts_british_american_and_contractions(self):
        text = "Colour and color are necessary. I don't need accomodation."
        result = check(text)
        self.assertEqual([text[r['start']:r['end']] for r in result['errors']], ['accomodation'])
        self.assertFalse(result['limited'])

    def test_spelling_offsets_match_browser_unicode_and_do_not_change_text(self):
        text = '🙂 Accomodation'
        result = check(text)
        self.assertEqual(result['errors'], [{'start':3, 'end':15}])
        self.assertEqual(text, '🙂 Accomodation')
        self.assertEqual(check("government’s necessary decision")['errors'], [])

    def test_spelling_checks_are_bounded(self):
        self.assertEqual(len(check('zzzzzz '*700)['errors']), 500)
        self.assertTrue(check('zzzzzz '*700)['limited'])
        for value in [None, [], 'x'*100001]:
            with self.assertRaises(ValueError):
                check(value)
