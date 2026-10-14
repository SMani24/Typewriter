import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
from typewriter.store import Store


class SchedulerAuditTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory();self.addCleanup(self.directory.cleanup)
        self.store=Store(Path(self.directory.name)/'audit.db')
        self.id=self.store.add_words([{'word':'example'}])['added'][0]

    def test_offset_dates_are_due_by_instant_and_promotions_use_utc(self):
        with self.store.db() as db:
            db.execute("UPDATE words SET due='2026-10-14T08:00:00+03:30',stage=1 WHERE id=?",(self.id,))
            db.execute("INSERT INTO attempts (word_id,answer,correct,mode,hinted,elapsed_ms,created) VALUES (?,'example',1,'review',0,0,'2026-10-14T00:30:00+03:30')",(self.id,))
        with patch('typewriter.store.datetime',wraps=datetime) as clock:
            clock.now.return_value=datetime(2026,10,14,7,tzinfo=timezone.utc)
            self.assertTrue(self.store.word(self.id)['is_due'])
            self.assertEqual(self.store.attempt(self.id,{'answer':'example'})['word']['stage'],2)

    def test_same_utc_day_with_different_local_dates_cannot_promote_twice(self):
        with self.store.db() as db:
            db.execute("UPDATE words SET stage=1 WHERE id=?",(self.id,))
            db.execute("INSERT INTO attempts (word_id,answer,correct,mode,hinted,elapsed_ms,created) VALUES (?,'example',1,'review',0,0,'2026-10-15T00:30:00+03:30')",(self.id,))
        with patch('typewriter.store.datetime',wraps=datetime) as clock:
            clock.now.return_value=datetime(2026,10,14,23,tzinfo=timezone.utc)
            self.assertEqual(self.store.attempt(self.id,{'answer':'example'})['word']['stage'],1)

    def test_new_attempts_preserve_context_and_server_schedule_snapshot(self):
        before=self.store.word(self.id)
        self.store.attempt(self.id,{'answer':'example','exercise':'sentence','session_kind':'selected'})
        attempt=self.store.export()['attempts'][-1]
        self.assertEqual((attempt['exercise'],attempt['session_kind'],attempt['scheduler']),('sentence','selected','legacy'))
        self.assertEqual((attempt['due_before'],attempt['stage_before']),(before['due'],before['stage']))
        restored=Store(Path(self.directory.name)/'restored.db');restored.import_backup(self.store.export())
        self.assertEqual(restored.export()['attempts'][0]['session_kind'],'selected')

    def test_historical_context_is_unknown_and_migration_preserves_instants(self):
        with self.store.db() as db:
            db.execute("PRAGMA user_version=0")
            db.execute("UPDATE words SET due='2026-10-14T08:00:00+03:30' WHERE id=?",(self.id,))
            db.execute("INSERT INTO attempts (word_id,answer,correct,mode,hinted,elapsed_ms,created) VALUES (?,'example',1,'review',0,0,'2026-10-14T00:30:00+03:30')",(self.id,))
        migrated=Store(self.store.path)
        self.assertEqual(migrated.word(self.id)['due'],'2026-10-14T04:30:00+00:00')
        attempt=migrated.export()['attempts'][0]
        self.assertEqual(attempt['created'],'2026-10-13T21:00:00+00:00')
        self.assertEqual((attempt['exercise'],attempt['session_kind'],attempt['stage_before']),('unknown','unknown',None))
        backup=migrated.export();del backup['attempt_metadata_version']
        for key in ['exercise','session_kind','scheduler','due_before','stage_before']:backup['attempts'][0].pop(key)
        other=Store(Path(self.directory.name)/'old.db');other.import_backup(backup)
        self.assertEqual(other.export()['attempts'][0]['exercise'],'unknown')

    def test_invalid_context_and_future_metadata_fail_before_writes(self):
        with self.assertRaises(ValueError):self.store.attempt(self.id,{'answer':'example','exercise':'meaning'})
        with self.assertRaises(ValueError):self.store.attempt(self.id,{'answer':'example','session_kind':'wrong'})
        self.assertEqual(self.store.export()['attempts'],[])
        backup=self.store.export();backup['attempt_metadata_version']=99
        with self.assertRaises(ValueError):self.store.import_backup(backup)

    def test_legacy_optional_success_policy_is_characterized_not_changed(self):
        # This is an approval-gated policy tradeoff in the supplied blueprint.
        with patch('typewriter.store.datetime',wraps=datetime) as clock:
            clock.now.return_value=datetime(2026,10,14,7,tzinfo=timezone.utc)
            first=self.store.attempt(self.id,{'answer':'example','session_kind':'normal'})['word']
            clock.now.return_value=datetime(2026,10,14,8,tzinfo=timezone.utc)
            second=self.store.attempt(self.id,{'answer':'example','session_kind':'selected'})['word']
            self.assertEqual(second['stage'],first['stage'])
            self.assertEqual(datetime.fromisoformat(second['due'])-datetime.fromisoformat(first['due']),timedelta(hours=1))
            for _ in range(8):self.store.attempt(self.id,{'answer':'example','session_kind':'endless'})
            self.assertEqual(self.store.word(self.id)['recent_accuracy'],100)

    def test_capped_priority_does_not_guarantee_coverage(self):
        unseen=self.store.practice_priority({},False,365)
        struggling=self.store.practice_priority({'correct':0,'total':8},True,365)
        self.assertEqual(unseen,8)
        self.assertGreater(struggling,unseen)
