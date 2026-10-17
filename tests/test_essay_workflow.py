import copy,json,tempfile,unittest
from datetime import datetime,timedelta,timezone
from pathlib import Path
from unittest.mock import Mock,patch
from typewriter.store import Store
from typewriter.essay_words import EssayWords
from typewriter.essay_intake import EssayIntake
from typewriter.dictionary import Dictionary
from typewriter.voice_preparation import VoicePreparation
from typewriter.spelling import check
from typewriter.preparation import Preparation
from typewriter.enrichment import Enrichment
from typewriter.scheduling import save_card,card_for


class EssayWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.store=Store(Path(self.temp.name)/'test.db');self.flags=EssayWords(self.store);self.intake=EssayIntake(self.store)
        self.id=self.store.add_words([{'word':'necessary','definition':'Required.','sentence':'Practice is necessary.','tip':'One c, two s.'}])['added'][0]

    def entry(self,text='It is neccessary.',word='necessary'):
        result=self.flags.extract(text);row=result['words'][0]
        return {'extraction_id':result['extraction_id'],'id':row['id'],'word':word}

    def material(self,word):return {'definition':'A specific useful meaning.','sentence':f'The {word} provides a useful context for this example.','tip':'Notice the spelling.'}

    def test_existing_essay_miss_is_due_in_both_engines_without_inventing_scores(self):
        future=(datetime.now(timezone.utc)+timedelta(days=20)).isoformat()
        with self.store.db() as db:
            db.execute('UPDATE words SET due=?,stage=4 WHERE id=?',(future,self.id))
            card=card_for(db,self.store.word(self.id));card.due=datetime.fromisoformat(future);save_card(db,card)
        before=self.store.export();entry=self.entry();result=self.intake.add({'mode':'manual','words':[entry]})
        self.assertEqual(result['marked'],[self.id]);self.assertEqual(result['added'],[])
        for scheduler in ('legacy','fsrs'):
            with self.store.db() as db:db.execute("INSERT OR REPLACE INTO settings VALUES ('scheduler',?)",(json.dumps(scheduler),))
            word=self.store.word(self.id);self.assertTrue(word['is_due']);self.assertTrue(word['essay_pending']);self.assertTrue(word['needs_help']);self.assertEqual(word['stage'],4)
        after=self.store.export();self.assertEqual(before['attempts'],after['attempts'])
        self.assertEqual(before['scheduling']['states'],after['scheduling']['states'])

    def test_same_essay_is_idempotent_even_after_new_extraction(self):
        first=self.entry();self.intake.add({'mode':'llm','words':[first,first]})
        again=self.entry();self.intake.add({'mode':'manual','words':[again]})
        self.assertEqual(self.store.word(self.id)['essay_mistakes'],1)
        self.assertEqual(self.store.word(self.id)['preparation_queue'],'')
        self.assertEqual(self.store.progress()['reviews'],0)

    def test_valid_original_is_not_recorded_as_a_spelling_mistake(self):
        # An uncommon valid spelling can be flagged; accepting it must not damage scores.
        result=self.flags.extract('Typewriterish');row=result['words'][0]
        result=self.intake.add({'mode':'manual','words':[{'extraction_id':result['extraction_id'],'id':row['id'],'word':'typewriterish'}]})
        word=self.store.word(result['added'][0]);self.assertEqual(word['essay_mistakes'],0)

    def test_only_successful_unaided_spelling_review_resolves_essay_reminder(self):
        self.intake.add({'mode':'manual','words':[self.entry()]})
        self.store.attempt(self.id,{'answer':'necessary','mode':'drill'})
        self.store.attempt(self.id,{'answer':'necessary','mode':'review','hinted':True})
        self.assertTrue(self.store.word(self.id)['essay_pending'])
        self.store.attempt(self.id,{'answer':'neccessary','mode':'review'})
        self.assertTrue(self.store.word(self.id)['essay_pending'])
        self.store.attempt(self.id,{'answer':'necessary','mode':'review'})
        self.assertFalse(self.store.word(self.id)['essay_pending'])

    def test_manual_queue_stays_out_of_every_practice_until_explicit_activation(self):
        result=self.intake.add({'mode':'manual','words':[self.entry('The enviroment matters.','environment')]});identity=result['added'][0]
        self.assertFalse(self.store.word(identity)['practice_ready'])
        with self.assertRaisesRegex(ValueError,'prepar'):self.store.start_session({'kind':'drill','ids':[identity]})
        with self.assertRaisesRegex(ValueError,'prepar'):self.store.attempt(identity,{'answer':'environment','mode':'drill'})
        self.store.edit_word(identity,{'definition':'The surroundings in which something lives.'})
        self.assertFalse(self.store.word(identity)['practice_ready'])
        self.store.activate_word(identity);self.assertTrue(self.store.word(identity)['practice_ready'])

    def test_empty_activation_is_atomic_and_keeps_material(self):
        result=self.intake.add({'mode':'manual','words':[self.entry('The enviroment matters.','environment')]});identity=result['added'][0]
        before=self.store.word(identity)
        with self.assertRaises(ValueError):self.store.edit_word(identity,{'tag':'Changed','activate':True})
        self.assertEqual(self.store.word(identity),before)
        self.store.set_audio(identity,file='00000000000000000000000000000000.wav',verified=True);before=self.store.word(identity)
        with self.assertRaises(ValueError):self.store.edit_word(identity,{'word':'environments','activate':True})
        self.assertEqual(self.store.word(identity),before)
        self.store.edit_word(identity,{'definition':'The surroundings.','activate':True});self.assertTrue(self.store.word(identity)['practice_ready'])

    def test_llm_queue_releases_after_details_manual_queue_is_not_auto_exported(self):
        result=self.intake.add({'mode':'llm','words':[self.entry('The enviroment matters.','environment')]});identity=result['added'][0]
        self.store.enrich_word(identity,self.material('environment'),'External LLM')
        self.assertTrue(self.store.word(identity)['practice_ready'])
        self.intake.add({'mode':'manual','words':[self.entry('An accomodation.','accommodation')]})
        enrichment=Enrichment(self.store,Mock(),Path(self.temp.name)/'no-keys')
        self.assertEqual(enrichment.pending(),[])
        with self.assertRaisesRegex(ValueError,'no words'):Preparation(self.store).export()

    def test_auto_voice_queue_waits_for_voice_then_stays_unchecked(self):
        result=self.intake.add({'mode':'llm_auto','words':[self.entry('The enviroment matters.','environment')]});identity=result['added'][0]
        self.store.enrich_word(identity,self.material('environment'),'External LLM');self.assertFalse(self.store.word(identity)['practice_ready'])
        dictionary=Dictionary(self.store,Mock());dictionary.pronunciation=Mock(return_value={})
        sources=dictionary.alternatives
        record=sources.record('environment','wiktionary','https://upload.wikimedia.org/wikipedia/commons/a/ab/En-us-environment.ogg','us','https://commons.wikimedia.org/wiki/File:En-us-environment.ogg','Test speaker','CC BY 4.0','https://creativecommons.org/licenses/by/4.0/')
        response=Mock(status_code=200);response.iter_content.return_value=[b'OggSsynthetic']
        with patch.object(sources,'fetch',side_effect=lambda w,p:[record] if p=='wiktionary' else []),patch.object(sources.network,'request',return_value=response):VoicePreparation(self.store,dictionary).run()
        word=self.store.word(identity);self.assertTrue(word['practice_ready']);self.assertFalse(word['audio_verified']);self.assertFalse(word['audio_eligible']);self.assertEqual(word['audio_alternative']['selection'],'automatic')

    def test_explicit_api_preparation_keeps_an_incomplete_manual_word_visible(self):
        identity=self.intake.add({'mode':'manual','words':[self.entry('The enviroment matters.','environment')]})['added'][0]
        enrichment=Enrichment(self.store,Mock(),Path(self.temp.name)/'no-keys');enrichment.generate=Mock(return_value={})
        enrichment.run([identity]);job=enrichment.snapshot()
        self.assertEqual(job['status'],'partial');self.assertEqual(job['done'],0)
        self.assertTrue(job['error']);self.assertFalse(self.store.word(identity)['practice_ready'])

    def test_bad_intake_entry_cannot_partially_add_or_mark_words(self):
        good=self.entry();bad={**good,'id':999999};before=self.store.export()
        with self.assertRaises(ValueError):self.intake.add({'mode':'manual','words':[good,bad]})
        self.assertEqual(self.store.export()['words'],before['words'])

    def test_dictionary_accepts_cv_inflections_and_personal_words_without_changing_essay(self):
        text='My CV lists the downsides of AnkiAutomata.'
        self.assertEqual(len(check(text)['errors']),1)
        self.store.set_personal_word('AnkiAutomata');self.assertEqual(check(text,self.store.personal_dictionary())['errors'],[])
        self.assertEqual(self.flags.extract(text)['words'],[])
        self.store.set_personal_word('AnkiAutomata',remove=True);self.assertEqual(len(self.flags.extract(text)['words']),1)
        self.assertEqual(len(self.store.list_words()),1)

    def test_backups_restore_queue_personal_words_and_essay_evidence(self):
        self.intake.add({'mode':'manual','words':[self.entry()]});self.intake.add({'mode':'llm','words':[self.entry('An accomodation.','accommodation')]});self.store.set_personal_word('AnkiAutomata')
        backup=self.store.export();other=Store(Path(self.temp.name)/'other.db');other.import_backup(backup)
        self.assertEqual(backup['version'],3)
        self.assertEqual(other.personal_dictionary(),['ankiautomata']);self.assertEqual(sum(w['essay_mistakes'] for w in other.list_words()),2)
        self.assertFalse(next(w for w in other.list_words() if w['word']=='accommodation')['practice_ready'])
        bad=copy.deepcopy(backup);bad['essay_slips'][0]['event_key']='invalid';empty=Store(Path(self.temp.name)/'invalid.db')
        with self.assertRaises(ValueError):empty.import_backup(bad)
        self.assertEqual(empty.list_words(),[]);self.assertEqual(empty.personal_dictionary(),[])

    def test_older_backup_formats_remain_compatible_and_future_formats_are_rejected(self):
        for version in (1,2):
            backup=self.store.export();backup['version']=version
            backup.pop('personal_dictionary');backup.pop('essay_slips')
            for word in backup['words']:
                for field in ('preparation_queue','essay_mistakes','essay_mistake_at'):word.pop(field)
            other=Store(Path(self.temp.name)/f'format-{version}.db');other.import_backup(backup)
            self.assertEqual(len(other.list_words()),1);self.assertTrue(other.list_words()[0]['practice_ready'])
        backup=self.store.export();backup['version']=4
        with self.assertRaises(ValueError):self.store.import_backup(backup)
