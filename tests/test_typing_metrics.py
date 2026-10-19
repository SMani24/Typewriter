import copy,json,sqlite3,tempfile,unittest
from datetime import datetime,timedelta,timezone
from pathlib import Path
from unittest.mock import patch
from typewriter.store import Store
from typewriter.typing_metrics import validate


def sample():
    return dict(version=1,initial_latency_ms=200,latency_basis='prompt-visible',typing_span_ms=600,active_typing_ms=600,idle_gap_ms=0,excluded_ms=0,input_events=4,revision_events=0,deleted_units=0,inserted_units=4,pause_bins=[3,0,0,0,0],max_pause_ms=200,focus_loss_count=0,hidden_count=0,audio_plays=0,audio_duration_ms=None,flags=['reading_prompt'])


class TypingMetricTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.store=Store(Path(self.temp.name)/'notebook.db')
        self.word=self.store.add_words([dict(word='example',definition='An illustration.',sentence='This is an example.',tip='End with ple.')])['added'][0]
        self.store.save_settings(dict(preparation_method='manual',sentence_enabled=False,audio_enabled=False,meaning_enabled=False))

    def session(self,enabled=True,kind='selected'):
        self.store.save_settings({'typing_metrics_enabled':enabled,'typing_input_method':'hardware'})
        return self.store.start_session({'kind':kind,'ids':[self.word]})

    def answer(self,session,**changes):
        data=dict(answer='example',mode='review',exercise='definition',session_kind='selected',session_id=session['id'],request_id='first',elapsed_ms=1200,typing=sample())
        data.update(changes);return self.store.attempt(self.word,data)

    def summaries(self):return [a.get('typing') for a in self.store.export()['attempts'] if a.get('typing')]

    def test_opt_in_gates_both_session_and_current_consent(self):
        self.assertFalse(self.store.settings()['typing_metrics_enabled'])
        session=self.session(False);self.answer(session);self.assertEqual(self.summaries(),[])
        self.store.session_touch(session['id'],end=True)
        session=self.session(True);self.store.save_settings({'typing_metrics_enabled':False});self.answer(session);self.assertEqual(self.summaries(),[])
        self.store.session_touch(session['id'],end=True)
        session=self.session(False);self.store.save_settings({'typing_metrics_enabled':True});self.answer(session);self.assertEqual(self.summaries(),[])

    def test_one_aggregate_per_word_per_session_and_idempotent_retry(self):
        session=self.session();first=self.answer(session)
        self.answer(session,typing={**sample(),'initial_latency_ms':999})
        self.assertEqual(len(self.summaries()),1);self.assertEqual(self.summaries()[0]['initial_latency_ms'],200)
        self.assertEqual(self.answer(session)['attempt_id'],first['attempt_id'])
        self.answer(session,request_id='second')
        self.assertEqual(len(self.summaries()),1)
        summary=self.summaries()[0]
        self.assertEqual(summary['input_method'],'hardware');self.assertEqual(summary['target_length'],7)
        self.assertNotEqual(summary['session_group'],session['id']);self.assertEqual(len(summary['session_group']),32)
        self.assertLess(len(json.dumps(summary)),1800)

    def test_assisted_and_nonspelling_attempts_have_no_summaries(self):
        session=self.session();self.answer(session,hinted=True);self.assertEqual(self.summaries(),[])
        self.answer(session,mode='correction',request_id='correction');self.assertEqual(self.summaries(),[])
        self.store.session_touch(session['id'],end=True)
        session=self.session(kind='drill');self.answer(session,mode='drill',exercise='drill',session_kind='drill');self.assertEqual(self.summaries(),[])

    def test_bad_or_future_metadata_does_not_change_correctness(self):
        session=self.session()
        bad=[None,[],{'version':2},{**sample(),'private_draft':'Never store this'}, {**sample(),'input_events':True},{**sample(),'active_typing_ms':99999},{**sample(),'flags':['private text']},{**sample(),'flags':[{}]}, {**sample(),'pause_bins':[10000]*5},{**sample(),'initial_latency_ms':float('nan')}]
        for i,payload in enumerate(bad):self.assertTrue(self.answer(session,request_id='bad-'+str(i),typing=payload)['correct'])
        self.assertEqual(self.summaries(),[])
        self.assertNotIn('Never store this',json.dumps(self.store.export()))

    def test_disabling_and_deleting_cannot_change_learning_data(self):
        session=self.session();self.answer(session);before=self.store.export()
        self.assertEqual(self.store.delete_typing_metrics(),{'deleted':1});self.assertFalse(self.store.settings()['typing_metrics_enabled'])
        self.answer(session,request_id='late');self.assertEqual(self.summaries(),[])
        after=self.store.export();self.assertEqual(after['words'],before['words']);self.assertEqual(after['attempts'][0],{k:v for k,v in before['attempts'][0].items() if k!='typing'})
        self.assertEqual(self.store.delete_typing_metrics(),{'deleted':0})

    def test_backup_roundtrip_optional_bad_metrics_and_old_backup(self):
        session=self.session();self.answer(session);backup=self.store.export()
        other=Store(Path(self.temp.name)/'restored.db');other.import_backup(backup)
        self.assertEqual(other.export()['attempts'][0]['typing'],backup['attempts'][0]['typing'])
        self.assertFalse(other.settings()['typing_metrics_enabled'],'A backup does not enable collection')
        for i,change in enumerate((lambda a:a.pop('typing'),lambda a:a['typing'].update(version=99),lambda a:a['typing'].update(input_method=[]))):
            old=copy.deepcopy(backup);change(old['attempts'][0]);restored=Store(Path(self.temp.name)/f'old-{i}.db');restored.import_backup(old)
            self.assertEqual(len(restored.export()['attempts']),1);self.assertNotIn('typing',restored.export()['attempts'][0])

    def test_additive_migration_backs_up_without_changing_records(self):
        session=self.session();self.answer(session);before=self.store.export()
        with self.store.db() as db:db.execute('DROP TABLE attempt_typing')
        reopened=Store(self.store.path);after=reopened.export()
        self.assertEqual(after['words'],before['words']);self.assertEqual(after['attempts'],[{k:v for k,v in a.items() if k!='typing'} for a in before['attempts']])
        backups=list((self.store.path.parent/'backups').glob('before-typing-metrics-*.db'));self.assertEqual(len(backups),1)
        with sqlite3.connect(backups[0]) as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM attempts').fetchone()[0],1)

    def test_both_schedulers_are_identical_with_and_without_collection(self):
        base=datetime.now(timezone.utc)+timedelta(seconds=1)
        for engine in ('legacy','fsrs'):
            left=Store(Path(self.temp.name)/(engine+'-on.db'));left.import_backup(self.store.export())
            with left.db() as db:db.execute("INSERT OR REPLACE INTO settings VALUES ('scheduler',?)",(json.dumps(engine),))
            right_path=Path(self.temp.name)/(engine+'-off.db')
            with sqlite3.connect(left.path) as source,sqlite3.connect(right_path) as destination:source.backup(destination)
            right=Store(right_path)
            for index,(answer,hinted) in enumerate((('example',False),('wrong',False),('example',True),('example',False))):
                at=base+timedelta(days=index*2)
                for store,enabled in ((left,True),(right,False)):
                    store.save_settings({'typing_metrics_enabled':enabled})
                    with patch('typewriter.scheduling.datetime',wraps=datetime) as clock,patch('typewriter.store.now',return_value=at.isoformat()):
                        clock.now.return_value=at
                        session=store.start_session({'kind':'selected','ids':[self.word]})
                        result=store.attempt(self.word,dict(answer=answer,hinted=hinted,elapsed_ms=1200,mode='review',exercise='definition',session_kind='selected',session_id=session['id'],request_id='answer',typing=sample()))
                        store.session_touch(session['id'],end=True)
                a,b=left.export(),right.export()
                self.assertEqual(a['words'],b['words']);self.assertEqual(a['scheduling'],b['scheduling']);self.assertEqual(left.progress(),right.progress())
                self.assertEqual([{k:v for k,v in attempt.items() if k!='typing'} for attempt in a['attempts']],b['attempts'])
            self.assertGreater(sum('typing' in a for a in left.export()['attempts']),0)
            self.assertTrue(all('typing' not in a for a in right.export()['attempts']))

    def test_slow_correct_answer_is_still_correct(self):
        session=self.session();slow={**sample(),'initial_latency_ms':60000,'typing_span_ms':60000,'active_typing_ms':0,'idle_gap_ms':60000,'pause_bins':[0,0,0,0,3],'max_pause_ms':20000,'flags':['reading_prompt','long_idle']}
        result=self.answer(session,typing=slow,elapsed_ms=120000)
        self.assertTrue(result['correct']);self.assertEqual(self.store.progress()['correct'],1);self.assertEqual(len(self.summaries()),1)

    def test_deleting_word_cascades_only_its_summaries(self):
        session=self.session();self.answer(session)
        self.store.delete_word(self.word)
        with self.store.db() as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM attempt_typing').fetchone()[0],0)

    def test_delete_endpoint_requires_token(self):
        import re
        from typewriter.web import create_app
        app=create_app(Path(self.temp.name)/'web',Path(self.temp.name)/'no-keys',background=False)
        client=app.test_client()
        self.assertEqual(client.delete('/api/typing-metrics').status_code,403)
        token=re.search('name="typewriter-token" content="([^"]+)"',client.get('/').text)[1]
        self.assertEqual(client.delete('/api/typing-metrics',headers={'X-Typewriter-Token':token}).json,{'deleted':0})

    def test_settings_reject_non_boolean_or_unknown_input_profiles(self):
        for values in ({'typing_metrics_enabled':1},{'typing_input_method':[]},{'typing_input_method':'keyboard-layout-fingerprint'}):
            with self.assertRaises(ValueError):self.store.save_settings(values)


if __name__=='__main__':unittest.main()
