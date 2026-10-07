import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import Mock
from typewriter.store import Store
from typewriter.preparation import Preparation
from typewriter.enrichment import Enrichment
from typewriter.web import create_app


class CorrectionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name)
        self.store = Store(self.path / 'test.db')
        self.id = self.store.add_words([{'word':'necessary', 'definition':'A wrong meaning.', 'sentence':'Practice is necessary.', 'tip':'One c, two s.'}])['added'][0]
        self.preparation = Preparation(self.store)
        self.material = {'definition':'Needed for a purpose.', 'sentence':'This change is necessary.', 'tip':'One c and two s letters.', 'distractors':['Optional for a purpose.', 'Suitable for a purpose.', 'Available for a purpose.']}

    def response(self, re_evaluate=False):
        stream, _ = self.preparation.export([self.id], 1, re_evaluate)
        with zipfile.ZipFile(stream) as archive:
            prompt = archive.read(next(n for n in archive.namelist() if n!='README.md')).decode()
        payload = json.loads(prompt.split('```json\n')[1].split('\n```')[0])
        payload['words'][0].update(self.material)
        return json.dumps(payload), prompt

    def test_flagged_ready_word_replaces_only_meaning_and_options(self):
        self.store.set_meaning_flag(self.id, True)
        text, prompt = self.response()
        self.assertIn('definition is WRONG', prompt)
        preview = self.preparation.preview(text)['words'][0]
        self.assertEqual(preview['replace'], ['definition','distractors'])
        self.assertEqual(preview['previous']['definition'], 'A wrong meaning.')
        self.assertEqual(self.preparation.apply(text)['updated'], 1)
        word = self.store.word(self.id)
        self.assertFalse(word['meaning_flagged'])
        self.assertEqual(word['definition'], self.material['definition'])
        self.assertEqual(word['sentence'], 'Practice is necessary.')
        self.assertEqual(word['tip'], 'One c, two s.')
        self.assertEqual(word['distractors'], self.material['distractors'])
        self.assertEqual(word['sources']['definition'], 'External LLM')
        self.assertEqual(self.preparation.apply(text)['updated'], 0)

    def test_re_evaluation_replaces_all_material_only_once(self):
        text, prompt = self.response(True)
        self.assertIn('"re_evaluate": true', prompt)
        self.assertEqual(len(self.preparation.preview(text)['words'][0]['replace']), 4)
        self.preparation.apply(text)
        word = self.store.word(self.id)
        for key, value in self.material.items():
            self.assertEqual(word[key], value)
        self.assertEqual(self.preparation.apply(text)['updated'], 0)

    def test_newer_edit_or_reflag_protects_replacement(self):
        for change in ('edit', 'reflag'):
            self.store.set_meaning_flag(self.id, True)
            text, _ = self.response()
            if change=='edit':
                self.store.edit_word(self.id, {'definition':'My corrected meaning.'})
            else:
                self.store.set_meaning_flag(self.id, False)
                self.store.set_meaning_flag(self.id, True)
            before = self.store.word(self.id)
            self.assertTrue(self.preparation.preview(text)['words'][0]['stale'])
            self.assertEqual(self.preparation.apply(text)['updated'], 0)
            self.assertEqual(self.store.word(self.id), before)

    def test_normal_export_cannot_replace_meaning_flagged_later(self):
        # Exported as ordinary incomplete material, then flagged after export.
        self.store.edit_word(self.id, {'tip':''})
        text, _ = self.response()
        self.store.set_meaning_flag(self.id, True)
        self.preparation.apply(text)
        self.assertEqual(self.store.word(self.id)['definition'], 'A wrong meaning.')
        self.assertTrue(self.store.word(self.id)['meaning_flagged'])

    def test_deleted_and_recreated_word_does_not_accept_old_re_evaluation(self):
        text, _ = self.response(True)
        self.store.delete_word(self.id)
        recreated = self.store.add_words([{'word':'necessary','definition':'A new manual meaning.'}])['added'][0]
        self.assertEqual(recreated, self.id)
        self.assertTrue(self.preparation.preview(text)['words'][0]['stale'])
        self.assertEqual(self.preparation.apply(text)['updated'], 0)
        self.assertEqual(self.store.word(recreated)['definition'], 'A new manual meaning.')

    def test_stale_quiz_cannot_score_against_a_changed_definition(self):
        version = self.store.word(self.id)['version']
        self.store.edit_word(self.id, {'definition':'A corrected meaning.'})
        with self.assertRaises(ValueError):
            self.store.attempt(self.id, {'mode':'meaning','answer':str(self.id),'version':version})
        self.assertEqual(self.store.progress()['meanings'], 0)

    def test_invalid_options_rejected_atomically(self):
        text, _ = self.response(True)
        for options in ([self.material['definition'],'Other','Third'], ['Same','same','Third'], ['Only one'], 'wrong type'):
            payload = json.loads(text)
            payload['words'][0]['distractors'] = options
            before = self.store.word(self.id)
            with self.assertRaises(ValueError):
                self.preparation.apply(json.dumps(payload))
            self.assertEqual(self.store.word(self.id), before)

    def test_generated_choices_scored_without_other_notebook_words(self):
        text, _ = self.response(True)
        self.preparation.apply(text)
        wrong = self.store.attempt(self.id, {'mode':'meaning','answer':'distractor:1'})
        self.assertFalse(wrong['correct'])
        correct = self.store.attempt(self.id, {'mode':'meaning','answer':str(self.id)})
        self.assertTrue(correct['correct'])
        self.assertEqual(self.store.progress()['reviews'], 0)
        self.assertEqual(self.store.progress()['meanings'], 2)
        self.assertEqual(self.store.export()['attempts'][0]['answer'], self.material['distractors'][1])
        self.store.set_meaning_flag(self.id, True)
        with self.assertRaises(ValueError):
            self.store.attempt(self.id, {'mode':'meaning','answer':str(self.id)})
        self.assertEqual(self.store.progress()['meanings'], 2)

    def test_editing_definition_clears_flag_and_obsolete_choices(self):
        text, _ = self.response(True)
        self.preparation.apply(text)
        self.store.set_meaning_flag(self.id, True)
        self.store.edit_word(self.id, {'definition':'My accurate meaning.'})
        word = self.store.word(self.id)
        self.assertFalse(word['meaning_flagged'])
        self.assertEqual(word['distractors'], [])

    def test_backup_roundtrip_preserves_flags_and_options(self):
        text, _ = self.response(True)
        self.preparation.apply(text)
        self.store.set_meaning_flag(self.id, True)
        restored = Store(self.path / 'restored.db')
        restored.import_backup(self.store.export())
        word = restored.list_words()[0]
        self.assertTrue(word['meaning_flagged'])
        self.assertEqual(word['distractors'], self.material['distractors'])

    def test_api_corrects_flagged_ready_words_but_does_not_auto_queue_them(self):
        keys = self.path / 'keys.txt'
        keys.write_text('fake-key')
        enrichment = Enrichment(self.store, Mock(), keys)
        self.store.set_meaning_flag(self.id, True)
        self.assertEqual(len(enrichment.pending()), 1)
        self.assertEqual(enrichment.pending(False), [])
        enrichment.generate = Mock(return_value={'necessary': self.material})
        enrichment.run([self.id])
        self.assertEqual(enrichment.snapshot()['status'], 'completed')
        self.assertFalse(self.store.word(self.id)['meaning_flagged'])
        self.assertEqual(self.store.word(self.id)['definition'], self.material['definition'])
        self.assertEqual(enrichment.snapshot()['ids'], [self.id])

    def test_edit_during_api_correction_is_preserved(self):
        enrichment = Enrichment(self.store, Mock(), self.path/'no-keys')
        self.store.set_meaning_flag(self.id, True)
        def generate(words):
            self.store.edit_word(self.id, {'definition':'A manual correction.'})
            return {'necessary': self.material}
        enrichment.generate = generate
        enrichment.run([self.id])
        self.assertEqual(self.store.word(self.id)['definition'], 'A manual correction.')
        self.assertEqual(self.store.word(self.id)['distractors'], [])

    def test_meaning_route_and_missing_keys_error(self):
        app = create_app(self.path/'web', self.path/'no-keys', background=False)
        client = app.test_client()
        import re
        token = re.search(r'name="typewriter-token" content="([^"]+)"', client.get('/').text).group(1)
        headers = {'X-Typewriter-Token':token}
        word_id = client.post('/api/words',json={'words':[{'word':'different'}]},headers=headers).json['added'][0]
        response = client.patch(f'/api/words/{word_id}/meaning',json={'flagged':True},headers=headers)
        self.assertTrue(response.json['meaning_flagged'])
        self.assertEqual(client.get('/api/state').json['enrichment']['pending'], 1)
        response = client.post('/api/enrichment/run',json={'ids':[word_id]},headers=headers)
        self.assertEqual(response.status_code, 400)
        self.assertIn('keys', response.json['error'])

    def test_schema_migration_retains_existing_word_and_attempts(self):
        self.store.attempt(self.id, {'answer':'necessary'})
        before = self.store.word(self.id)
        with self.store.db() as db:
            for column in ('meaning_flagged','distractors'):
                db.execute(f'ALTER TABLE words DROP COLUMN {column}')
        migrated = Store(self.store.path).word(self.id)
        for key in ('word','definition','sentence','tip','version','created','due','reviews'):
            self.assertEqual(migrated[key], before[key])
        self.assertFalse(migrated['meaning_flagged'])
        self.assertEqual(migrated['distractors'], [])
