import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typewriter.store import Store


class SchedulingTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = Store(Path(self.directory.name)/'test.db')
        self.weak, self.strong, self.new = self.store.add_words([{'word':w} for w in ('necessary','different','environment')])['added']

    def attempts(self, word_id, answers, mode='review', hinted=False):
        stamp = datetime.now(timezone.utc).isoformat()
        with self.store.db() as db:
            db.executemany('INSERT INTO attempts(word_id,answer,correct,mode,hinted,elapsed_ms,created) VALUES (?,?,?,?,?,?,?)', [(word_id,'sample',correct,mode,int(hinted),0,stamp) for correct in answers])

    def test_recent_struggles_rank_before_new_and_well_remembered_words(self):
        self.attempts(self.weak,[1]*30+[0]*8)
        self.attempts(self.strong,[0]*30+[1]*8)
        weak, strong, new = (self.store.word(i) for i in (self.weak,self.strong,self.new))
        self.assertGreater(weak['accuracy'],strong['accuracy'])
        self.assertEqual(weak['recent_accuracy'],0)
        self.assertEqual(strong['recent_accuracy'],100)
        self.assertGreater(weak['review_priority'],new['review_priority'])
        self.assertGreater(new['review_priority'],strong['review_priority'])
        self.assertEqual(weak['recent_reviews'],8)

    def test_new_mistake_and_hint_bring_a_word_forward(self):
        self.attempts(self.weak,[1]*8)
        self.attempts(self.strong,[1]*8)
        self.attempts(self.weak,[0])
        self.assertTrue(self.store.word(self.weak)['needs_help'])
        self.assertGreater(self.store.word(self.weak)['review_priority'],self.store.word(self.strong)['review_priority'])
        self.attempts(self.strong,[1],hinted=True)
        word=self.store.word(self.strong)
        self.assertTrue(word['needs_help'])
        self.assertEqual(word['recent_accuracy'],100)
        self.assertEqual(word['reviews'],8)

    def test_drills_and_quizzes_do_not_change_spelling_priority(self):
        before=self.store.word(self.weak)['review_priority']
        self.attempts(self.weak,[1]*40,mode='drill')
        self.attempts(self.weak,[0]*8,mode='meaning')
        word=self.store.word(self.weak)
        self.assertEqual(word['review_priority'],before)
        self.assertGreater(word['meaning_priority'],self.store.word(self.strong)['meaning_priority'])
        self.assertEqual(word['reviews'],0)

    def test_overdue_words_catch_up_and_success_keeps_the_due_gate(self):
        self.attempts(self.strong,[1]*8)
        self.attempts(self.weak,[0]*8)
        with self.store.db() as db:
            db.execute('UPDATE words SET due=? WHERE id=?',((datetime.now(timezone.utc)-timedelta(days=60)).isoformat(),self.strong))
        self.assertGreater(self.store.word(self.strong)['review_priority'],self.store.word(self.weak)['review_priority'])
        self.store.attempt(self.new,{'answer':'environment'})
        self.assertFalse(self.store.word(self.new)['is_due'])

    def test_cadence_settings_persist_and_validate_atomically(self):
        self.assertEqual(self.store.settings()['quiz_interval_min'],5)
        self.store.save_settings({'quiz_interval_mode':'range','quiz_interval_min':2,'quiz_interval_max':7})
        reopened=Store(self.store.path)
        self.assertEqual((reopened.settings()['quiz_interval_min'],reopened.settings()['quiz_interval_max']),(2,7))
        before=self.store.settings()
        for changes in ({'quiz_interval_min':8},{'quiz_interval_min':True},{'quiz_interval_max':11},{'quiz_interval_mode':'invalid'},{'quiz_interval_mode':'fixed'}):
            with self.assertRaises(ValueError): self.store.save_settings(changes)
            self.assertEqual(self.store.settings(),before)
        self.store.save_settings({'quiz_interval_mode':'fixed','quiz_interval_min':5,'quiz_interval_max':5})

    def test_short_review_size_persists_and_rejects_invalid_values(self):
        self.assertEqual(self.store.settings()['review_session_size'],10)
        for size in (1,25,100):
            self.store.save_settings({'review_session_size':size})
            self.assertEqual(Store(self.store.path).settings()['review_session_size'],size)
        before=self.store.settings()
        for size in (0,101,True,3.5,'10',None):
            with self.assertRaises(ValueError):
                self.store.save_settings({'review_session_size':size,'auto_ai':not before['auto_ai']})
            self.assertEqual(self.store.settings(),before)
