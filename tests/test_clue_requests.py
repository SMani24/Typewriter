import json
import sqlite3
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import Mock
from typewriter.store import Store
from typewriter.preparation import Preparation
from typewriter.enrichment import Enrichment
from typewriter.network import Network
from typewriter.web import create_app


class ClueRequestTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.path=Path(self.temp.name);self.store=Store(self.path/'test.db')
        self.id=self.store.add_words([{'word':'comfortable','definition':'A vague meaning.','sentence':'A comfortable chair.','tip':'Keep this manual tip.'}])['added'][0]
        self.preparation=Preparation(self.store)
        self.material={'definition':'Giving physical ease and relaxation.','sentence':'The padded seat was so comfortable that she fell asleep during the journey.','tip':'New tip that must not overwrite the manual tip.','distractors':['Causing physical pain or irritation.','Costing very little money to buy.','Happening suddenly without warning.']}

    def reply(self):
        stream,_=self.preparation.export()
        with zipfile.ZipFile(stream) as archive:
            prompt=archive.read(next(n for n in archive.namelist() if n!='README.md')).decode()
        data=json.loads(prompt.split('```json\n')[1].split('\n```')[0]);data['words'][0].update(self.material)
        return json.dumps(data),prompt

    def test_flagged_example_is_queued_and_only_that_field_is_replaced(self):
        before=self.store.word(self.id);self.store.set_sentence_flag(self.id,True)
        self.assertEqual(self.store.word(self.id)['clue'],'')
        text,prompt=self.reply();self.assertIn('sentence_flagged',prompt);self.assertIn('semantic context',prompt)
        self.assertEqual(self.preparation.preview(text)['words'][0]['replace'],['sentence'])
        self.assertEqual(self.preparation.apply(text)['updated'],1)
        word=self.store.word(self.id)
        self.assertEqual(word['sentence'],self.material['sentence']);self.assertFalse(word['sentence_flagged']);self.assertTrue(word['clue'])
        for field in ('definition','tip','due','stage','reviews','drills'):self.assertEqual(word[field],before[field])
        self.assertEqual(self.preparation.apply(text)['updated'],0)

    def test_both_flags_replace_clues_and_quiz_options_keep_manual_tip(self):
        self.store.set_sentence_flag(self.id,True);self.store.set_meaning_flag(self.id,True)
        text,_=self.reply();self.assertEqual(set(self.preparation.preview(text)['words'][0]['replace']),{'sentence','definition','distractors'})
        self.preparation.apply(text);word=self.store.word(self.id)
        self.assertFalse(word['sentence_flagged']);self.assertFalse(word['meaning_flagged'])
        self.assertEqual(word['definition'],self.material['definition']);self.assertEqual(word['distractors'],self.material['distractors']);self.assertEqual(word['tip'],'Keep this manual tip.')

    def test_old_reply_cannot_overwrite_newer_manual_example_or_flags(self):
        self.store.set_sentence_flag(self.id,True);text,_=self.reply()
        self.store.edit_word(self.id,{'sentence':'After hours on her feet, she finally found a comfortable seat.'})
        self.assertFalse(self.store.word(self.id)['sentence_flagged'])
        self.store.set_meaning_flag(self.id,True);before=self.store.word(self.id)
        self.assertTrue(self.preparation.preview(text)['words'][0]['stale']);self.assertEqual(self.preparation.apply(text)['updated'],0)
        self.assertEqual(self.store.word(self.id),before)

    def test_incomplete_api_reply_keeps_flag_and_future_batch_queue(self):
        self.store.set_sentence_flag(self.id,True)
        word=self.store.word(self.id);snapshot={'version':word['version'],'created':word['created'],'kind':'flagged'}
        self.assertFalse(self.store.enrich_word(self.id,{'sentence':'The target spelling is missing.'},'Gemini',snapshot))
        self.assertTrue(self.store.word(self.id)['sentence_flagged'])
        keys=self.path/'keys';keys.write_text('fake-test-key-no-network')
        enrichment=Enrichment(self.store,Network(self.store),keys)
        self.assertEqual([w['id'] for w in enrichment.pending(False)],[self.id])
        enrichment.generate=Mock(return_value={'comfortable':self.material})
        self.store.save_settings({'auto_ai':False});enrichment.run([self.id])
        self.assertFalse(self.store.word(self.id)['sentence_flagged']);self.assertEqual(enrichment.pending(),[])

    def test_example_flags_backup_roundtrip_and_old_backup_compatibility(self):
        self.store.set_sentence_flag(self.id,True);backup=self.store.export()
        restored=Store(self.path/'restored.db');restored.import_backup(backup)
        self.assertTrue(restored.list_words()[0]['sentence_flagged']);self.assertEqual(restored.list_words()[0]['clue'],'')
        backup['words'][0].pop('sentence_flagged');old=Store(self.path/'old.db');old.import_backup(backup);self.assertFalse(old.list_words()[0]['sentence_flagged'])
        backup['words'][0]['sentence_flagged']='yes';empty=Store(self.path/'invalid.db')
        with self.assertRaises(ValueError):empty.import_backup(backup)
        self.assertEqual(empty.list_words(),[])

    def test_all_due_is_default_and_finite_selection_exceeds_ten(self):
        self.store.add_words([{'word':'example'+chr(97+i),'definition':'A clue.'} for i in range(24)])
        self.store.save_settings({'meaning_enabled':False,'sentence_enabled':False,'audio_enabled':False})
        session=self.store.start_session({'kind':'normal'})
        self.assertEqual(len(session['words']),25)
        ids=[self.store.session_next(session['id'],i)['word']['id'] for i in range(25)]
        self.assertEqual(len(set(ids)),25);self.assertIsNone(self.store.session_next(session['id'],25)['word'])
        self.store.session_touch(session['id'],end=True)
        self.store.save_settings({'review_session_size':5});limited=self.store.start_session({'kind':'normal'})
        self.assertEqual(len(limited['words']),5)
        for i in range(5):self.assertIsNotNone(self.store.session_next(limited['id'],i)['word'])
        self.assertIsNone(self.store.session_next(limited['id'],5)['word'])

    def test_previous_default_upgrades_once_custom_limits_stay(self):
        for old_limit,new_limit in ((10,0),(7,7)):
            path=self.path/f'upgrade-{old_limit}.db';store=Store(path);store.save_settings({'review_session_size':old_limit})
            with store.db() as db:db.execute("DELETE FROM cache WHERE name='review-size-default-v2'")
            upgraded=Store(path);self.assertEqual(upgraded.settings()['review_session_size'],new_limit)
            upgraded.save_settings({'review_session_size':10});self.assertEqual(Store(path).settings()['review_session_size'],10)

    def test_existing_database_migration_preserves_words_and_backs_up(self):
        # Create a genuine pre-flag schema without editing any production notebook.
        with sqlite3.connect(self.store.path) as db:
            db.execute('ALTER TABLE words DROP COLUMN sentence_flagged')
            before=db.execute('SELECT word,definition,sentence,due,stage FROM words').fetchall()
        migrated=Store(self.store.path)
        with migrated.db() as db:self.assertEqual(db.execute('SELECT word,definition,sentence,due,stage FROM words').fetchall()[0][:],before[0])
        backups=list((self.path/'backups').glob('before-clue-flags-*.db'));self.assertEqual(len(backups),1)
        with sqlite3.connect(backups[0]) as db:self.assertEqual(db.execute('SELECT word,definition,sentence,due,stage FROM words').fetchall(),before)

    def test_sentence_flag_endpoint_rejects_missing_consent_token_and_bad_types(self):
        app=create_app(self.path/'web',background=False);client=app.test_client();import re
        token=re.search(r'name="typewriter-token" content="([^"]+)"',client.get('/').text).group(1);headers={'X-Typewriter-Token':token}
        identity=app.extensions['store'].add_words([{'word':'comfortable'}])['added'][0];url=f'/api/words/{identity}/sentence'
        self.assertEqual(client.patch(url,json={'flagged':True}).status_code,403)
        self.assertEqual(client.patch(url,json={'flagged':'yes'},headers=headers).status_code,400)
        self.assertTrue(client.patch(url,json={'flagged':True},headers=headers).json['sentence_flagged'])
