import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from typewriter.store import Store
from typewriter.dictionary import Dictionary


class PronunciationTests(unittest.TestCase):
    def setUp(self):
        directory=tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store=Store(Path(directory.name)/'test.db')
        self.id=self.store.add_words([{'word':'necessary'}])['added'][0]
        self.urls={region:f'https://dictionary.cambridge.org/{region}-necessary.mp3' for region in ('uk','us')}
        self.network=Mock()
        self.dictionary=Dictionary(self.store,self.network)
        self.store.edit_word(self.id,{'source':'Cambridge','audio_url':self.urls['uk'],'audio_urls':self.urls})
        self.store.set_audio(self.id,verified=True)

    def response(self):
        response=Mock(status_code=200)
        response.iter_content.return_value=[b'ID3sample']
        return response

    def test_saved_accent_and_request_override_choose_separate_cached_files(self):
        with patch.object(self.network,'request',side_effect=[self.response(),self.response()]) as request:
            uk=self.dictionary.audio(self.id)
            self.store.save_settings({'pronunciation_accent':'us'})
            us=self.dictionary.audio(self.id)
            self.assertNotEqual(uk,us)
            self.assertEqual(self.dictionary.audio(self.id,accent='uk'),uk)
            self.assertEqual([call.args[1] for call in request.call_args_list],[self.urls['uk'],self.urls['us']])
        self.assertEqual(Store(self.store.path).settings()['pronunciation_accent'],'us')

    def test_missing_accent_never_falls_back_or_enters_audio_only_reviews(self):
        self.store.edit_word(self.id,{'source':'Cambridge','audio_urls':{'uk':self.urls['uk']}})
        self.store.set_audio(self.id,verified=True)
        self.store.save_settings({'pronunciation_accent':'us'})
        self.assertFalse(self.store.word(self.id)['audio_eligible'])
        with patch.object(self.dictionary,'lookup',return_value={'audio':{'uk':self.urls['uk']}}):
            with self.assertRaisesRegex(ValueError,'No US pronunciation'):
                self.dictionary.audio(self.id)
        self.network.request.assert_not_called()

    def test_legacy_recording_keeps_uk_and_resolves_us_on_demand(self):
        self.store.edit_word(self.id,{'source':'Cambridge','audio_urls':{}})
        with patch.object(self.dictionary,'lookup',return_value={'audio':self.urls}) as lookup, patch.object(self.network,'request',side_effect=[self.response(),self.response()]):
            self.dictionary.audio(self.id)
            lookup.assert_not_called()
            self.dictionary.audio(self.id,accent='us')
            lookup.assert_called_once_with('necessary')
        self.assertEqual(self.store.word(self.id)['audio_urls'],self.urls)

    def test_uploaded_recording_overrides_both_accents_and_flags_are_honoured(self):
        directory=self.store.path.parent/'audio';directory.mkdir()
        name='a'*32+'.wav';path=directory/name;path.write_bytes(b'RIFFsample')
        self.store.set_audio(self.id,file=name,verified=True)
        for accent in ('uk','us'):
            self.assertEqual(self.dictionary.audio(self.id,accent=accent),path)
        self.store.set_audio(self.id,flagged=True)
        with self.assertRaisesRegex(ValueError,'flagged'):
            self.dictionary.audio(self.id)
        self.assertEqual(self.dictionary.audio(self.id,preview=True),path)
        self.network.request.assert_not_called()

    def test_audio_urls_roundtrip_and_invalid_values_are_rejected_atomically(self):
        backup=self.store.export()
        other=Store(self.store.path.parent/'other.db');other.import_backup(backup)
        self.assertEqual(other.list_words()[0]['audio_urls'],self.urls)
        before=self.store.word(self.id)
        for urls in ({'ca':self.urls['uk']},{'us':'http://example.com/a.mp3'},[],{'uk':None}):
            with self.assertRaises(ValueError):
                self.store.edit_word(self.id,{'source':'Cambridge','definition':'Changed','audio_urls':urls})
            self.assertEqual(self.store.word(self.id),before)
        with self.assertRaises(ValueError):self.store.save_settings({'pronunciation_accent':'ca'})
        with self.assertRaises(ValueError):self.dictionary.audio(self.id,accent='ca')

    def test_parallel_preloads_download_only_once(self):
        from concurrent.futures import ThreadPoolExecutor
        with patch.object(self.network,'request',return_value=self.response()) as request:
            with ThreadPoolExecutor(max_workers=4) as pool:
                paths=list(pool.map(lambda _:self.dictionary.audio(self.id),range(4)))
            self.assertEqual(request.call_count,1)
        self.assertTrue(all(p==paths[0] for p in paths))
        self.assertEqual(paths[0].read_bytes(),b'ID3sample')
