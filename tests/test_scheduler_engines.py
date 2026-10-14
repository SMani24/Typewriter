import copy
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
from typewriter.store import Store
from typewriter.scheduling import CONFIG_ID, SESSION_SECONDS, adapter, card_for, save_card, utc


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.store=Store(Path(self.tmp.name)/'test.db')
        self.ids=self.store.add_words([{'word':w,'definition':'Meaning of '+w,'sentence':'It is '+w+'.'} for w in ('example','different','necessary','missing','simple','oldest')])['added']
        self.at=datetime.now(timezone.utc)

    def switch(self, target, store=None):
        store=store or self.store
        preview=store.scheduler_preview(target)
        store.scheduler_switch({'target':target,'token':preview['token']})
        return preview

    def session(self,kind='selected',ids=None,**kwargs):
        return self.store.start_session({'kind':kind,'ids':ids or self.ids,**kwargs})

    def answer(self, session, word_id=None, answer=None, **kwargs):
        word=self.store.word(word_id or self.ids[0])
        with self.store.db() as db:
            kind=db.execute('SELECT kind FROM practice_sessions WHERE id=?',(session['id'],)).fetchone()['kind']
        return self.store.attempt(word['id'],{'session_id':session['id'],'session_kind':kind,'exercise':'definition','answer':answer or word['word'],**kwargs})

    def states(self):
        return self.store.export()['scheduling']['states']

    def test_default_preview_is_read_only_and_switch_is_reversible_after_restart(self):
        before=self.states();legacy=self.store.export()['words']
        preview=self.store.scheduler_preview('fsrs')
        self.assertEqual(self.store.settings()['scheduler'],'legacy')
        self.assertEqual(self.states(),before)
        self.assertEqual(preview['counts']['fsrs']['new'],6)
        self.switch('fsrs')
        self.assertEqual(Store(self.store.path).settings()['scheduler'],'fsrs')
        for target in ('legacy','fsrs','legacy'):
            self.switch(target)
            self.assertEqual(self.states(),before)
            self.assertEqual(self.store.export()['words'],legacy)

    def test_dual_states_update_from_due_answers_and_extra_practice_is_excluded(self):
        first=self.session();self.answer(first)
        self.store.session_touch(first['id'],end=True)
        state=self.states()[0];self.assertIsNotNone(state['card']['stability'])
        legacy=self.store.export()['words'][0]
        self.switch('fsrs');s=self.session()
        # FSRS short learning step not yet due: extra success changes neither engine.
        self.answer(s)
        next_state=self.states()[0]
        self.assertEqual(state['card'],next_state['card'])
        self.assertGreater(next_state['cursor'],state['cursor'])
        self.assertEqual(self.store.export()['words'][0]['due'],legacy['due'])
        # A due FSRS failure changes FSRS and Legacy shadows, retaining the active tag.
        with self.store.db() as db:
            card=card_for(db,self.store.word(self.ids[0]));card.due=self.at-timedelta(seconds=1);save_card(db,card,next_state['cursor'])
        self.answer(s,answer='wrong')
        self.assertEqual(self.store.export()['attempts'][-1]['scheduler'],'fsrs')
        self.assertTrue(self.store.word(self.ids[0])['needs_help'])
        self.store.session_touch(s['id'],end=True)
        self.switch('legacy')
        self.assertLess(utc(self.store.word(self.ids[0])['due']),self.at+timedelta(minutes=11))

    def test_active_session_blocks_switch_and_forged_or_expired_context(self):
        preview=self.store.scheduler_preview('fsrs');s=self.session()
        for action in (lambda:self.store.scheduler_preview('fsrs'),lambda:self.store.scheduler_switch({'target':'fsrs','token':preview['token']}),lambda:self.store.attempt(self.ids[0],{'answer':'example'}),lambda:self.answer(s,session_kind='endless')):
            with self.assertRaises(ValueError):action()
        self.assertEqual(self.store.export()['attempts'],[])
        with self.store.db() as db:db.execute("UPDATE practice_sessions SET expires='2000-01-01T00:00:00+00:00'")
        with self.assertRaises(ValueError):self.answer(s)
        with self.assertRaises(ValueError):self.store.session_touch(s['id'])
        self.switch('fsrs')
        with self.assertRaises(ValueError):self.store.attempt(self.ids[0],{'answer':'example'})

    def test_preview_rejects_modified_materials_answers_settings_and_time(self):
        changes=[lambda:self.store.edit_word(self.ids[0],{'tip':'A tip'}),
                 lambda:self.store.attempt(self.ids[0],{'answer':'example'}),
                 lambda:self.store.save_settings({'audio_volume':70})]
        for change in changes:
            p=self.store.scheduler_preview('fsrs');change()
            with self.assertRaises(ValueError):self.store.scheduler_switch({'target':'fsrs','token':p['token']})
        p=self.store.scheduler_preview('fsrs')
        with patch('typewriter.scheduling.datetime',wraps=datetime) as clock:
            clock.now.return_value=self.at+timedelta(minutes=4)
            with self.assertRaises(ValueError):self.store.scheduler_switch({'target':'fsrs','token':p['token']})
        with self.assertRaises(ValueError):self.store.save_settings({'scheduler':'fsrs'})

    def test_coverage_carries_between_short_sessions_without_early_or_disabled_words(self):
        self.store.save_settings({'review_session_size':1})
        oldest=self.ids[-1]
        with self.store.db() as db:
            db.execute('UPDATE words SET due=?,created=?',((self.at-timedelta(days=99)).isoformat(),(self.at-timedelta(days=100)).isoformat()))
            db.execute('UPDATE words SET due=? WHERE id=?',((self.at-timedelta(days=100)).isoformat(),oldest))
            # Very strong old evidence lowers this word below the competing pool.
            for _ in range(8):db.execute("INSERT INTO attempts(word_id,answer,correct,mode,hinted,elapsed_ms,created,spaced_recall,evidence_version) VALUES (?,'oldest',1,'review',0,0,?,1,1)",(oldest,self.at.isoformat()))
        # Selected/endless sessions do not consume normal credit.
        for kind in ('selected','endless'):
            s=self.session(kind);self.store.session_touch(s['id'],end=True)
        with self.store.db() as db:self.assertEqual(json.loads(db.execute("SELECT value FROM cache WHERE name='coverage-position'").fetchone()['value']),0)
        offered=[]
        for i in range(5):
            s=self.store.start_session({'kind':'normal'});offered.append(s['words'][0]['id'])
            self.store.session_touch(s['id'],end=True)
            self.store=Store(self.store.path)
        self.assertEqual(offered[-1],oldest)
        self.assertNotEqual(offered[0],oldest)
        # A future date still excludes the oldest word even at a coverage position.
        with self.store.db() as db:
            db.execute('UPDATE words SET due=? WHERE id=?',((self.at+timedelta(days=1)).isoformat(),oldest))
            db.execute("UPDATE cache SET value='4' WHERE name='coverage-position'")
        s=self.store.start_session({'kind':'normal'})
        self.assertNotEqual(s['words'][0]['id'],oldest)

    def test_coverage_next_is_idempotent_and_rechecks_material(self):
        s=self.store.start_session({'kind':'normal'})
        first=s['words'][0]
        second=self.store.session_next(s['id'],1)['word']
        again=self.store.session_next(s['id'],1)['word']
        self.assertEqual(second['id'],again['id']);self.assertNotEqual(first['id'],second['id'])
        with self.assertRaises(ValueError):self.store.session_next(s['id'],9)
        # Removing material invalidates admission even though the original queue had it.
        for word in self.store.list_words():
            if word['id'] not in (first['id'],second['id']):self.store.edit_word(word['id'],{'sentence':'','definition':''})
        self.assertIsNone(self.store.session_next(s['id'],2)['word'])

    def test_v2_full_restore_merge_id_mapping_old_backup_and_reset(self):
        self.switch('fsrs');s=self.session();self.answer(s);self.store.session_touch(s['id'],end=True)
        backup=self.store.export()
        restored=Store(Path(self.tmp.name)/'restored.db');restored.import_backup(backup)
        self.assertEqual(restored.settings()['scheduler'],'fsrs')
        self.assertEqual(restored.export()['scheduling']['states'],backup['scheduling']['states'])
        merged=Store(Path(self.tmp.name)/'merge.db');merged.add_words([{'word':'another'}]);merged.import_backup(backup)
        self.assertEqual(merged.settings()['scheduler'],'legacy')
        state=next(s for s in merged.export()['scheduling']['states'] if s['card']['last_review'])
        self.assertNotEqual(state['word_id'],backup['scheduling']['states'][0]['word_id'])
        self.assertEqual(state['card']['card_id'],state['word_id'])
        with merged.db() as db:self.assertEqual(db.execute('SELECT word_id FROM attempts WHERE id=?',(state['cursor'],)).fetchone()['word_id'],state['word_id'])
        before=merged.export();merged.import_backup(backup)
        self.assertEqual(merged.export()['scheduling'],before['scheduling'])
        old=copy.deepcopy(backup);old['version']=1;old.pop('scheduling')
        legacy=Store(Path(self.tmp.name)/'old.db');legacy.import_backup(old)
        self.assertEqual(legacy.settings()['scheduler'],'legacy')
        self.assertTrue(all(s['card']['last_review'] is None for s in legacy.export()['scheduling']['states']))
        self.store.edit_word(self.ids[0],{'word':'examples','sentence':'These are examples.'})
        self.assertIsNone(self.states()[0]['card']['last_review'])
        self.assertEqual(self.store.word(self.ids[0])['stage'],0)
        self.assertEqual(len(self.store.export()['attempts']),1)

    def test_malformed_future_backups_are_atomic(self):
        backup=self.store.export()
        for alter in (lambda b:b['scheduling'].update(version=9),lambda b:b['scheduling']['config'].update(library='future'),lambda b:b['scheduling']['states'][0].update(cursor=999),lambda b:b['scheduling']['states'][0]['card'].update(stability=float('nan')),lambda b:b['scheduling']['states'][0]['card'].update(card_id=999)):
            bad=copy.deepcopy(backup);alter(bad)
            empty=Store(Path(self.tmp.name)/'empty.db')
            with self.assertRaises(ValueError):empty.import_backup(bad)
            self.assertEqual(empty.list_words(),[])

    def test_meaning_drill_correction_do_not_touch_either_spelling_state(self):
        self.switch('fsrs');s=self.session();before=self.states()[0]['card'];legacy=self.store.export()['words'][0]
        self.answer(s,mode='meaning',exercise='meaning',answer=str(self.ids[0]))
        self.answer(s,mode='correction',hinted=True)
        self.store.session_touch(s['id'],end=True)
        d=self.session('drill',[self.ids[0]])
        self.answer(d,mode='drill',exercise='drill')
        self.assertEqual(self.states()[0]['card'],before)
        self.assertEqual(self.store.export()['words'][0]['due'],legacy['due'])
        self.assertEqual(self.store.progress()['spaced_reviews'],0)

    def test_utc_overdue_elapsed_and_empty_notebook(self):
        empty=Store(Path(self.tmp.name)/'blank.db')
        p=self.switch('fsrs',empty);self.assertEqual(p['counts']['fsrs']['due'],0)
        self.switch('legacy',empty)
        self.switch('fsrs');s=self.session();self.answer(s);self.store.session_touch(s['id'],end=True)
        with self.store.db() as db:card=card_for(db,self.store.word(self.ids[0]))
        early=adapter().get_card_retrievability(card,current_datetime=self.at+timedelta(days=1))
        late=adapter().get_card_retrievability(card,current_datetime=self.at+timedelta(days=10))
        self.assertLess(late,early)
        before=self.states()[0]['card']['due'];self.switch('legacy');self.switch('fsrs')
        self.assertEqual(self.states()[0]['card']['due'],before)
        self.assertEqual(utc('2026-10-14T08:00:00+03:30'),datetime(2026,10,14,4,30,tzinfo=timezone.utc))

    def test_lost_answer_response_retry_is_idempotent(self):
        self.switch('fsrs');s=self.session()
        result=self.answer(s,answer='wrong',request_id='same-request')
        again=self.answer(s,answer='wrong',request_id='same-request')
        self.assertEqual(result['attempt_id'],again['attempt_id'])
        self.assertEqual(len(self.store.export()['attempts']),1)
        with self.assertRaises(ValueError):self.answer(s,request_id='same-request')
        self.assertEqual(len(self.store.export()['attempts']),1)
        self.store.session_touch(s['id'],end=True)
        self.assertEqual(self.answer(s,answer='wrong',request_id='same-request')['attempt_id'],result['attempt_id'])

    def test_early_success_does_not_block_a_later_due_promotion_or_change_shadow(self):
        # Early correct answers are not the day's scheduled promotion.
        base=datetime.now(timezone.utc)
        word=self.ids[0]
        with self.store.db() as db:db.execute('UPDATE words SET due=? WHERE id=?',((base+timedelta(hours=1)).isoformat(),word))
        self.store.attempt(word,{'answer':'example','exercise':'definition','session_kind':'selected'})
        with patch('typewriter.store.datetime',wraps=datetime) as clock:
            clock.now.return_value=base+timedelta(hours=2)
            self.assertEqual(self.store.attempt(word,{'answer':'example','exercise':'definition','session_kind':'selected'})['word']['stage'],1)
        # Conversely, an early FSRS success must not promote an overdue Legacy shadow.
        self.switch('fsrs');s=self.session()
        with self.store.db() as db:
            db.execute('UPDATE words SET due=? WHERE id=?',((base-timedelta(days=1)).isoformat(),word))
            current=self.store.word(word);card=card_for(db,current);card.due=base+timedelta(days=1);save_card(db,card)
        legacy=self.store.export()['words'][0]
        self.answer(s)
        after=self.store.export()['words'][0]
        self.assertEqual((after['stage'],after['due']),(legacy['stage'],legacy['due']))

    def test_old_notebook_upgrade_creates_backup_once_and_preserves_original_columns(self):
        import sqlite3
        with self.store.db() as db:
            db.execute('PRAGMA user_version=1')
            db.execute('DROP TABLE spelling_schedules')
            # Existing history has no reliable context; it is accounted for, not replayed.
            db.execute("INSERT INTO attempts(word_id,answer,correct,mode,hinted,elapsed_ms,created) VALUES (?,'wrong',0,'review',0,0,?)",(self.ids[0],self.at.isoformat()))
            words=[dict(r) for r in db.execute('SELECT * FROM words')]
            attempts=[dict(r) for r in db.execute('SELECT * FROM attempts')]
        migrated=Store(self.store.path)
        backups=list((self.store.path.parent/'backups').glob('before-scheduler-v2-*.db'))
        self.assertEqual(len(backups),1)
        with sqlite3.connect(backups[0]) as db:self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0],1)
        with migrated.db() as db:
            self.assertEqual([dict(r) for r in db.execute('SELECT * FROM words')],words)
            self.assertEqual([dict(r) for r in db.execute('SELECT * FROM attempts')],attempts)
        self.assertEqual(migrated.settings()['scheduler'],'legacy')
        state=migrated.export()['scheduling']['states'][0]
        self.assertIsNone(state['card']['last_review']);self.assertEqual(state['cursor'],attempts[0]['id'])
        Store(self.store.path)
        self.assertEqual(len(list((self.store.path.parent/'backups').glob('*.db'))),1)

    def test_config_and_exercises_are_frozen_and_changed_clues_are_rejected(self):
        s=self.session()
        self.store.save_settings({'definition_enabled':False})
        self.assertTrue(s['settings']['definition_enabled'])
        self.answer(s)  # Frozen enabled exercise remains usable.
        self.store.edit_word(self.ids[0],{'definition':''})
        with self.assertRaises(ValueError):self.answer(s)
        with self.store.db() as db:db.execute('UPDATE practice_sessions SET config=? WHERE id=?',('foreign-config',s['id']))
        with self.assertRaises(ValueError):self.answer(s)

    def test_fsrs_same_day_due_steps_update_memory_without_inflating_daily_evidence(self):
        self.switch('fsrs');s=self.session();self.answer(s);self.store.session_touch(s['id'],end=True)
        first=self.states()[0]['card'];legacy=self.store.export()['words'][0]
        future=utc(first['due'])+timedelta(seconds=1)
        with patch('typewriter.store.datetime',wraps=datetime) as store_clock, patch('typewriter.scheduling.datetime',wraps=datetime) as scheduler_clock:
            store_clock.now.return_value=future;scheduler_clock.now.return_value=future
            s=self.session();self.answer(s);self.store.session_touch(s['id'],end=True)
        self.assertEqual(self.states()[0]['card']['state'],2)
        self.assertEqual(self.store.export()['words'][0]['due'],legacy['due'])
        self.assertEqual([a['fsrs_rating'] for a in self.store.export()['attempts']],[3,3])
        self.assertEqual(self.store.progress()['spaced_reviews'],1)

    def test_preview_rejects_newly_due_card_without_any_database_change(self):
        at=datetime.now(timezone.utc)
        with self.store.db() as db:
            word=self.store.word(self.ids[0]);card=card_for(db,word);card.due=at+timedelta(minutes=1);save_card(db,card)
        preview=self.store.scheduler_preview('fsrs')
        with patch('typewriter.scheduling.datetime',wraps=datetime) as clock:
            clock.now.return_value=at+timedelta(minutes=2)
            with self.assertRaises(ValueError):self.store.scheduler_switch({'target':'fsrs','token':preview['token']})

    def test_audio_material_uses_session_accent_when_other_tab_changes_default(self):
        self.store.set_pronunciation(self.ids[0],'',{'uk':'https://dictionary.cambridge.org/example.mp3'})
        self.store.set_audio(self.ids[0],verified=True)
        self.store.save_settings({'sentence_enabled':False,'definition_enabled':False,'audio_enabled':True})
        self.switch('fsrs');s=self.session()
        self.store.save_settings({'pronunciation_accent':'us'})
        self.assertFalse(self.store.word(self.ids[0])['audio_eligible'])
        self.answer(s,exercise='audio')
        self.assertEqual(self.store.export()['attempts'][-1]['fsrs_rating'],3)
