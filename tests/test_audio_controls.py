import json,tempfile,unittest
from datetime import datetime,timedelta,timezone
from pathlib import Path
from unittest.mock import patch
from typewriter.store import Store
from typewriter.web import create_app


class AudioControlTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.store=Store(Path(self.temp.name)/'test.db')
        self.ids=self.store.add_words([{'word':'necessary'},{'word':'missing'}])['added']
        for identity in self.ids:self.store.set_audio(identity,file='0'*32+'.wav',verified=True)
        self.store.save_settings({'sentence_enabled':False,'definition_enabled':False,'meaning_enabled':False,'audio_enabled':True})

    def test_pause_keeps_grades_due_dates_and_enabled_preference(self):
        before=self.store.export();until=self.store.pause_audio()
        self.assertGreater(datetime.fromisoformat(until),datetime.now(timezone.utc))
        session=self.store.start_session({'kind':'selected','ids':self.ids})
        self.assertEqual(session['words'],[]);self.assertTrue(session['settings']['audio_enabled'])
        self.store.session_touch(session['id'],end=True)
        self.assertEqual(before['attempts'],self.store.export()['attempts'])
        self.assertEqual(before['words'],self.store.export()['words'])
        self.assertTrue(self.store.settings()['audio_enabled'])
        self.store.pause_audio(True);session=self.store.start_session({'kind':'selected','ids':self.ids})
        self.assertEqual(len(session['words']),2)

    def test_pause_affects_next_offer_in_existing_normal_session_and_expires(self):
        session=self.store.start_session({'kind':'normal'});self.assertEqual(len(session['words']),2)
        self.store.pause_audio();result=self.store.session_next(session['id'],1)
        self.assertIsNone(result['word']);self.store.session_touch(session['id'],end=True)
        with self.store.db() as db:db.execute("INSERT OR REPLACE INTO cache VALUES ('audio-pause-until',?)",(json.dumps((datetime.now(timezone.utc)-timedelta(seconds=1)).isoformat()),))
        self.assertEqual(self.store.audio_pause_until(),'')
        self.assertEqual(len(self.store.start_session({'kind':'normal'})['words']),2)

    def test_invalid_advanced_settings_do_not_partly_save(self):
        before=self.store.settings()
        for data in ({'audio_repeat_gap_seconds':True},{'audio_repeat_gap_seconds':float('nan')},{'audio_repeat_gap_seconds':11},{'audio_pause_minutes':0},{'audio_pause_minutes':2.5}):
            with self.assertRaises(ValueError):self.store.save_settings(data)
            self.assertEqual(before,self.store.settings())


class DiagnosticTests(unittest.TestCase):
    def setUp(self):
        import re
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.app=create_app(self.temp.name,Path(self.temp.name)/'no-keys',background=False);self.client=self.app.test_client()
        self.headers={'X-Typewriter-Token':re.search('name="typewriter-token" content="([^"]+)"',self.client.get('/').text).group(1)}

    def test_server_trace_records_locations_without_exception_contents(self):
        secret='private-key-and-personal-essay'
        with patch.object(self.app.extensions['store'],'progress',side_effect=RuntimeError(secret)):
            response=self.client.get('/api/state')
        self.assertEqual(response.status_code,500);self.assertTrue(response.json['reference'])
        exported=self.client.get('/api/logs/export').text
        self.assertNotIn(secret,exported);self.assertIn('RuntimeError',exported);self.assertIn('typewriter/web.py',exported)

    def test_browser_reports_ignore_messages_and_reject_untrusted_locations(self):
        response=self.client.post('/api/diagnostics',json={'kind':'error','source':'essay_words.js','line':41,'message':'never expose this','stack':'private'},headers=self.headers)
        self.assertEqual(response.status_code,202)
        exported=self.client.get('/api/logs/export').text
        self.assertIn('essay_words.js',exported);self.assertNotIn('never expose this',exported);self.assertNotIn('private',exported)
        for data in ({'kind':'other'},{'kind':'error','source':'../api_keys.txt'},{'kind':'error','line':-1}):
            self.assertEqual(self.client.post('/api/diagnostics',json=data,headers=self.headers).status_code,400)
        self.assertEqual(self.client.post('/api/diagnostics',json={'kind':'error'}).status_code,403)

    def test_interrupted_stream_is_a_recoverable_error_without_private_details(self):
        import requests
        from unittest.mock import Mock
        store=self.app.extensions['store'];identity=store.add_words([{'word':'necessary'}])['added'][0]
        store.set_pronunciation(identity,'uk',{'uk':'https://dictionary.cambridge.org/clip.mp3'})
        response=Mock(status_code=200);response.iter_content.side_effect=requests.ConnectionError('private-key-and-proxy-details')
        with patch.object(self.app.extensions['network'],'request',return_value=response) as request:
            result=self.client.get(f'/api/words/{identity}/audio')
        self.assertEqual(result.status_code,400);self.assertIn('interrupted',result.json['error'])
        self.assertEqual(request.call_args.kwargs['timeout'],(5,12));response.close.assert_called_once()
        self.assertNotIn('private-key-and-proxy-details',self.client.get('/api/logs/export').text)
