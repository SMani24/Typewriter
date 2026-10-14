import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from typewriter.store import Store


class DrillPriorityTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = Store(Path(self.directory.name) / 'notebook.db')
        self.id = self.store.add_words([{'word': 'necessary'}])['added'][0]
        for _ in range(2):
            self.store.attempt(self.id, {'mode': 'review', 'answer': 'necesary'})

    def drill(self, correct=10, incorrect=0):
        ids = []
        for answer, total in [('necessary', correct), ('wrong', incorrect)]:
            for _ in range(total):
                ids.append(self.store.attempt(self.id, {'mode': 'drill', 'answer': answer})['attempt_id'])
        return {'first_attempt_id': ids[0], 'last_attempt_id': ids[-1], 'version': self.store.word(self.id)['version']}

    def test_completed_drill_reduces_only_drill_priority_and_survives_reload(self):
        records = self.drill()
        before = self.store.word(self.id)
        word = self.store.complete_drill(self.id, records)['word']
        self.assertTrue(word['drill_recommended'])
        self.assertTrue(word['drill_cooling'])
        self.assertEqual(word['drill_priority'], before['review_priority'] * 0.25)
        for field in ['review_priority', 'reviews', 'correct_reviews', 'stage', 'due', 'recent_mistakes', 'recall_streak']:
            self.assertEqual(word[field], before[field])
        self.assertTrue(Store(self.store.path).word(self.id)['drill_cooling'])
        self.assertEqual(self.store.progress()['reviews'], 2)
        self.assertEqual(self.store.progress()['drills'], 10)
        restored = Store(Path(self.directory.name) / 'restored.db')
        restored.import_backup(self.store.export())
        self.assertTrue(restored.list_words()[0]['drill_cooling'])

    def test_short_or_inaccurate_drill_gets_no_reduction(self):
        for correct, incorrect in [(9, 0), (10, 3)]:
            with self.subTest(correct=correct, incorrect=incorrect):
                result = self.store.complete_drill(self.id, self.drill(correct, incorrect))
                self.assertFalse(result['qualifies'])
                self.assertFalse(result['word']['drill_cooling'])

    def test_exact_eighty_percent_accuracy_qualifies(self):
        result = self.store.complete_drill(self.id, self.drill(12, 3))
        self.assertTrue(result['qualifies'])
        self.assertTrue(result['word']['drill_cooling'])

    def test_retries_do_not_extend_or_stack_the_reduction(self):
        records = self.drill()
        first = self.store.complete_drill(self.id, records)['word']
        second = self.store.complete_drill(self.id, records)['word']
        self.assertEqual(first['drill_completed_at'], second['drill_completed_at'])
        self.assertEqual(first['drill_cooldown_until'], second['drill_cooldown_until'])
        self.assertEqual(second['drill_priority'], second['review_priority'] * 0.25)

    def test_reduction_expires_at_twenty_four_hours(self):
        word = self.store.complete_drill(self.id, self.drill())['word']
        completed = datetime.fromisoformat(word['drill_completed_at'])
        with patch('typewriter.store.datetime', wraps=datetime) as clock:
            clock.now.return_value = completed + timedelta(hours=23, minutes=59)
            self.assertTrue(self.store.word(self.id)['drill_cooling'])
            clock.now.return_value = completed + timedelta(hours=24)
            expired = self.store.word(self.id)
            self.assertFalse(expired['drill_cooling'])
            self.assertEqual(expired['drill_priority'], expired['review_priority'])
            self.assertIsNone(expired['drill_cooldown_until'])

    def test_later_miss_or_hint_cancels_reduction_permanently(self):
        for answer, hinted in [('wrong', False), ('necessary', True)]:
            with self.subTest(answer=answer, hinted=hinted):
                self.store.complete_drill(self.id, self.drill())
                self.store.attempt(self.id, {'mode': 'review', 'answer': answer, 'hinted': hinted})
                self.assertFalse(self.store.word(self.id)['drill_cooling'])
                self.store.attempt(self.id, {'mode': 'review', 'answer': 'necessary'})
                self.assertFalse(self.store.word(self.id)['drill_cooling'])

    def test_late_completion_response_cannot_hide_a_newer_struggle(self):
        records = self.drill()
        self.store.attempt(self.id, {'mode': 'review', 'answer': 'wrong'})
        self.store.attempt(self.id, {'mode': 'review', 'answer': 'necessary'})
        self.assertFalse(self.store.complete_drill(self.id, records)['word']['drill_cooling'])

    def test_spelling_changes_clear_reduction_and_reject_old_drills(self):
        records = self.drill()
        self.store.complete_drill(self.id, records)
        self.store.edit_word(self.id, {'word': 'necessity'})
        self.assertFalse(self.store.word(self.id)['drill_cooling'])
        with self.assertRaisesRegex(ValueError, 'changed during the drill'):
            self.store.complete_drill(self.id, records)
        records['version'] = self.store.word(self.id)['version']
        with self.assertRaisesRegex(ValueError, 'one drill'):
            self.store.complete_drill(self.id, records)

    def test_other_words_and_mixed_review_records_cannot_complete_drills(self):
        records = self.drill()
        other = self.store.add_words([{'word': 'different'}])['added'][0]
        with self.assertRaisesRegex(ValueError, 'one drill'):
            self.store.complete_drill(other, records)
        self.store.attempt(self.id, {'mode': 'review', 'answer': 'necessary'})
        records['last_attempt_id'] = self.store.attempt(self.id, {'mode': 'drill', 'answer': 'necessary'})['attempt_id']
        with self.assertRaisesRegex(ValueError, 'one drill'):
            self.store.complete_drill(self.id, records)
        self.assertFalse(self.store.word(self.id)['drill_cooling'])

    def test_old_backups_and_invalid_drill_dates(self):
        backup = self.store.export()
        del backup['words'][0]['drill_completed_at']
        restored = Store(Path(self.directory.name) / 'legacy.db')
        restored.import_backup(backup)
        self.assertFalse(restored.list_words()[0]['drill_cooling'])
        for date in ['not a date', '2026-10-14T12:00:00', 0]:
            backup['words'][0]['drill_completed_at'] = date
            with self.assertRaisesRegex(ValueError, 'practice date'):
                restored.import_backup(backup)

    def test_correct_recall_and_corrections_keep_the_reduction(self):
        self.store.complete_drill(self.id, self.drill())
        for mode, answer in [('review', 'necessary'), ('correction', 'wrong'), ('drill', 'wrong')]:
            self.store.attempt(self.id, {'mode': mode, 'answer': answer})
            self.assertTrue(self.store.word(self.id)['drill_cooling'])
