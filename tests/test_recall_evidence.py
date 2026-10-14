import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
from typewriter.store import Store


class RecallEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.store = Store(Path(self.tmp.name)/'test.db')
        self.id = self.store.add_words([{'word':'example','definition':'An illustration.'}])['added'][0]
        self.base = datetime(2026,10,1,9,tzinfo=timezone.utc)
        with self.store.db() as db:
            db.execute('UPDATE words SET created=?,due=?',(self.base.isoformat(),self.base.isoformat()))

    def answer(self, at, answer='example', **data):
        with patch('typewriter.store.datetime',wraps=datetime) as clock:
            clock.now.return_value=at
            return self.store.attempt(self.id,{'answer':answer,'exercise':'definition','session_kind':'selected',**data})

    def test_extra_success_preserves_due_and_all_review_totals(self):
        first=self.answer(self.base)['word']
        for i in range(8):self.answer(self.base+timedelta(minutes=i+1))
        word=self.store.word(self.id)
        self.assertEqual((word['stage'],word['due']),(first['stage'],first['due']))
        self.assertEqual(self.store.progress()['reviews'],9)
        self.assertEqual(self.store.progress()['spaced_reviews'],1)
        self.assertEqual(word['spaced_recent_reviews'],1)
        self.assertEqual(word['recent_reviews'],8)
        with patch('typewriter.store.datetime',wraps=datetime) as clock:
            clock.now.return_value=self.base+timedelta(minutes=10)
            self.assertEqual(self.store.word(self.id)['review_priority'],first['review_priority'])

    def test_first_due_unaided_answer_per_utc_day_is_evidence(self):
        self.answer(self.base,'wrong')
        self.answer(self.base+timedelta(minutes=11))
        self.assertEqual(self.store.progress()['spaced_reviews'],1)
        self.assertEqual(self.store.progress()['spaced_correct'],0)
        self.answer(self.base+timedelta(days=2))
        self.assertEqual(self.store.progress()['spaced_reviews'],2)

    def test_hints_and_corrections_never_count_but_struggles_survive(self):
        self.answer(self.base,hinted=True)
        self.assertTrue(self.store.word(self.id)['needs_help'])
        self.answer(self.base+timedelta(minutes=1),mode='correction',hinted=True)
        self.assertEqual(self.store.progress()['spaced_reviews'],0)
        self.assertTrue(self.store.word(self.id)['needs_help'])
        self.answer(self.base+timedelta(minutes=11))
        self.assertEqual(self.store.progress()['spaced_reviews'],1)

    def test_unknown_history_is_retained_without_invented_evidence(self):
        with self.store.db() as db:
            db.execute("INSERT INTO attempts(word_id,answer,correct,mode,hinted,elapsed_ms,created) VALUES (?,'example',1,'review',0,0,?)",(self.id,self.base.isoformat()))
        self.assertEqual(self.store.progress()['reviews'],1)
        self.assertEqual(self.store.progress()['spaced_reviews'],0)
        self.assertEqual(self.store.word(self.id)['spaced_recent_reviews'],0)
