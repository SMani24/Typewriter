import json
import unittest
from datetime import datetime, timedelta, timezone
from fsrs_lab import Lab, demonstration


class LaboratoryTests(unittest.TestCase):
    def setUp(self):
        self.at=datetime(2026,10,1,9,tzinfo=timezone.utc)
        self.lab=Lab();self.lab.add(1,self.at)

    def test_mapping_and_independent_meaning(self):
        self.assertEqual(self.lab.observe(1,self.at,correct=True)['rating'],3)
        self.assertIsNone(self.lab.words[1]['meaning'].stability)
        later=self.at+timedelta(days=1)
        self.assertEqual(self.lab.observe(1,later,correct=True,hinted=True)['rating'],1)
        spelling=self.lab.words[1]['spelling'].to_dict()
        self.lab.observe(1,later,correct=True,mode='meaning',exercise='meaning')
        self.assertEqual(self.lab.words[1]['spelling'].to_dict(),spelling)
        self.assertIsNotNone(self.lab.words[1]['meaning'].stability)

    def test_practice_and_unknown_context_do_not_train_fsrs(self):
        self.lab.observe(1,self.at,correct=True)
        original=self.lab.words[1]['spelling'].to_dict()
        for mode, context in [('drill','drill'),('correction','normal'),('review','selected'),('review','endless'),('review','unknown')]:
            self.lab.observe(1,self.at,correct=True,mode=mode,context=context)
        self.assertEqual(self.lab.words[1]['spelling'].to_dict(),original)
        self.assertEqual(len(self.lab.events),6)

    def test_multiple_switches_do_not_destroy_either_state(self):
        self.lab.observe(1,self.at,correct=True)
        words=self.lab.dump()['words']
        for mode in ['fsrs','legacy','fsrs','legacy']:
            self.lab.switch(mode,self.at+timedelta(days=20),confirm=True)
            self.assertEqual(self.lab.dump()['words'],words)
        self.assertEqual(self.lab.active,'legacy')
        self.assertEqual(len(self.lab.switches),4)

    def test_preview_and_active_session_gate(self):
        self.lab.switch('fsrs',self.at)
        self.assertEqual(self.lab.active,'legacy')
        with self.assertRaises(ValueError):self.lab.switch('fsrs',self.at,confirm=True,session_active=True)
        self.assertEqual(self.lab.active,'legacy')
        self.assertEqual(self.lab.preview(self.at)['legacy_due'],1)

    def test_elapsed_time_changes_retrievability_without_rewriting_due(self):
        self.lab.observe(1,self.at,correct=True)
        card=self.lab.words[1]['spelling'];due=card.due
        near=self.lab.scheduler.get_card_retrievability(card,self.at+timedelta(days=1))
        far=self.lab.scheduler.get_card_retrievability(card,self.at+timedelta(days=30))
        self.assertLess(far,near)
        self.assertEqual(card.due,due)
        self.assertEqual(self.lab.preview(self.at+timedelta(days=30))['fsrs_due'],1)

    def test_restore_and_reset_preserve_history(self):
        self.lab.observe(1,self.at,correct=True)
        restored=Lab.restore(json.loads(json.dumps(self.lab.dump())))
        self.assertEqual(restored.dump(),self.lab.dump())
        restored.reset(1,self.at+timedelta(days=2))
        self.assertEqual(len(restored.events),1)
        self.assertEqual(restored.words[1]['stage'],0)
        self.assertIsNone(restored.words[1]['spelling'].stability)
        with self.assertRaises(ValueError):Lab.restore({**self.lab.dump(),'schema':99})

    def test_timezones_empty_collection_and_determinism(self):
        empty=Lab();self.assertEqual(empty.preview(self.at)['fsrs_due'],0)
        offset=self.at.astimezone(timezone(timedelta(hours=3,minutes=30)))
        self.lab.observe(1,offset,correct=True)
        self.assertEqual(self.lab.events[-1]['at'],self.at.isoformat())
        with self.assertRaises(ValueError):self.lab.preview(datetime(2026,10,1))
        self.assertEqual(demonstration(),demonstration())

    def test_same_day_due_steps_and_legacy_comparison(self):
        self.lab.observe(1,self.at,correct=True)
        self.lab.switch('fsrs',self.at,confirm=True)
        next_due=self.lab.words[1]['spelling'].due
        self.assertEqual(self.lab.observe(1,next_due,correct=True)['rating'],3)
        self.assertEqual(self.lab.words[1]['stage'],1)
        before=self.lab.words[1]['spelling'].to_dict()
        self.assertIsNone(self.lab.observe(1,next_due+timedelta(seconds=1),correct=True)['rating'])
        self.assertEqual(self.lab.words[1]['spelling'].to_dict(),before)

    def test_legacy_baseline_matches_the_real_store(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        from typewriter.store import Store
        with tempfile.TemporaryDirectory() as directory:
            store=Store(Path(directory)/'comparison.db')
            word=store.add_words([{'word':'example'}])['added'][0]
            with store.db() as db:
                db.execute('UPDATE words SET created=?,due=? WHERE id=?',(self.at.isoformat(),self.at.isoformat(),word))
            for minutes,correct,hinted,context in [(0,True,False,'normal'),(1,True,False,'selected'),(2,False,False,'endless'),(3,True,True,'normal'),(1440,True,False,'normal'),(6000,True,False,'normal')]:
                at=self.at+timedelta(minutes=minutes)
                self.lab.observe(1,at,correct=correct,hinted=hinted,context=context)
                with patch('typewriter.store.datetime',wraps=datetime) as clock:
                    clock.now.return_value=at
                    result=store.attempt(word,{'answer':'example' if correct else 'wrong','hinted':hinted,'session_kind':context})['word']
                self.assertEqual(result['stage'],self.lab.words[1]['stage'])
                self.assertEqual(result['due'],self.lab.words[1]['due'].isoformat())
