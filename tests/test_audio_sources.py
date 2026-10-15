"""Original small markup fixtures and synthetic audio; no dictionary assets or network."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from concurrent.futures import ThreadPoolExecutor

from typewriter.audio_sources import AudioSources
from typewriter.audio_metadata import validate_record
from typewriter.dictionary import Dictionary
from typewriter.network import NetworkError
from typewriter.store import Store
from typewriter.scheduling import audio_eligible
from typewriter.web import create_app


class AudioSourceTests(unittest.TestCase):
    def setUp(self):
        directory=tempfile.TemporaryDirectory();self.addCleanup(directory.cleanup)
        self.store=Store(Path(directory.name)/'test.db')
        self.id=self.store.add_words([{'word':'highest'}])['added'][0]
        self.network=Mock()
        self.dictionary=Dictionary(self.store,self.network)
        self.sources=self.dictionary.alternatives
        self.record=self.sources.record('highest','wiktionary','https://upload.wikimedia.org/wikipedia/commons/2/27/En-us-highest.ogg','us','https://commons.wikimedia.org/wiki/File:En-us-highest.ogg','Example speaker','CC BY-SA 3.0','https://creativecommons.org/licenses/by-sa/3.0/')

    def response(self,content=b'OggSsynthetic',status=200,headers=None):
        response=Mock(status_code=status,headers=headers or {})
        response.iter_content.return_value=[content]
        return response

    def offer(self,record=None):
        with patch.object(self.sources,'fetch',return_value=[record or self.record]):
            return self.sources.options(self.id,'wiktionary')['candidates'][0]

    def choose(self):
        record=self.offer()
        with patch.object(self.network,'request',return_value=self.response()):self.sources.preview(self.id,record['id'])
        return self.sources.accept(self.id,record['id'])

    def test_oxford_only_exact_headword_and_its_recordings(self):
        html='''<div class="top-container"><h1 class="headword">highest</h1><div class="sound pron-us" data-src-mp3="/media/english/highest.mp3"></div></div><div class="sound pron-uk" data-src-mp3="/media/english/unrelated.mp3"></div>'''
        records=self.sources.oxford('highest',html,'https://www.oxfordlearnersdictionaries.com/definition/english/highest')
        self.assertEqual(len(records),1);self.assertTrue(records[0]['url'].endswith('/highest.mp3'))
        self.assertEqual(self.sources.oxford('highest',html.replace('>highest<','>high<'),records[0]['source_url']),[])

    def test_wiktionary_requires_english_exact_word_and_file(self):
        html='''<h1 id="firstHeading">highest</h1><h2 id="English">English</h2><table class="audiotable"><audio data-mwtitle="en-us-high.ogg"></audio><audio data-mwtitle="en-us-highest.ogg"></audio></table><h2 id="French">French</h2><table class="audiotable"><audio data-mwtitle="fr-highest.ogg"></audio></table>'''
        self.assertEqual(self.sources.wiki_titles('highest',html),['File:en-us-highest.ogg'])
        self.assertEqual(self.sources.wiki_titles('highest',html.replace('>highest<','>high<')),[])
        self.assertEqual(self.sources.wiki_titles('highest',html.replace('id="English"','id="Dutch"')),[])

    def test_commons_preserves_plain_attribution_and_license(self):
        payload={'query':{'pages':{'1':{'title':'File:En-us-highest.ogg','imageinfo':[{'url':self.record['url'],'descriptionurl':self.record['source_url'],'extmetadata':{'Artist':{'value':'<a href="/User:Example">Example speaker</a>'},'LicenseShortName':{'value':'CC BY-SA 3.0'},'LicenseUrl':{'value':'http://creativecommons.org/licenses/by-sa/3.0/'}}}]}}}}
        with patch.object(self.sources,'read',return_value=(json.dumps(payload).encode(),'')):
            records=self.sources.wiki_records('highest',self.sources.commons(titles=['File:En-us-highest.ogg']),'wiktionary')
        self.assertEqual(records,[self.record])
        payload['query']['pages']['1']['imageinfo'][0]['extmetadata'].pop('Artist')
        with patch.object(self.sources,'read',return_value=(json.dumps(payload).encode(),'')):
            self.assertEqual(self.sources.wiki_records('highest',self.sources.commons(titles=['File:En-us-highest.ogg']),'wiktionary'),[])

    def test_free_dictionary_requires_exact_entry_and_resolves_commons_ids(self):
        phonetics=[{'audio':'https://api.dictionaryapi.dev/voice.mp3','sourceUrl':'https://commons.wikimedia.org/w/index.php?curid=42'}]
        payload=[{'word':'high','phonetics':phonetics},{'word':'highest','phonetics':phonetics}]
        with patch.object(self.sources,'read',return_value=(json.dumps(payload).encode(),'')),patch.object(self.sources,'commons',return_value=[]) as commons:
            self.sources.fetch(self.store.word(self.id),'free_dictionary');commons.assert_called_once_with(pageids=['42'])
        with patch.object(self.sources,'read',return_value=(json.dumps(payload[:1]).encode(),'')),patch.object(self.sources,'commons') as commons:
            self.assertEqual(self.sources.fetch(self.store.word(self.id),'free_dictionary'),[]);commons.assert_not_called()

    def test_options_and_preview_do_not_modify_word_or_schedule(self):
        before=self.store.export();self.offer()
        with patch.object(self.network,'request',return_value=self.response()):self.sources.preview(self.id,self.record['id'])
        after=self.store.export()
        for field in ('words','attempts','scheduling'):self.assertEqual(before[field],after[field])
        self.assertFalse(self.store.word(self.id)['audio_eligible'])

    def test_rejection_persists_deduplicates_and_explicit_reset_reconsiders(self):
        self.offer();self.sources.reject(self.id,self.record['id'])
        reloaded=AudioSources(Store(self.store.path),self.network)
        self.assertEqual(reloaded.options(self.id,'wiktionary')['candidates'],[])
        duplicate={**self.record,'provider':'free_dictionary'}
        with patch.object(reloaded,'fetch',return_value=[duplicate]):self.assertEqual(reloaded.options(self.id,'free_dictionary')['candidates'],[])
        with self.assertRaisesRegex(ValueError,'Preview'):self.sources.accept(self.id,self.record['id'])
        self.assertEqual(len(reloaded.options(self.id,'wiktionary',reset=True)['candidates']),1)
        self.network.request.assert_not_called()

    def test_approval_requires_preview_and_rejected_choices_cannot_be_approved(self):
        self.offer()
        with self.assertRaisesRegex(ValueError,'Preview'):self.sources.accept(self.id,self.record['id'])
        with patch.object(self.network,'request',return_value=self.response()):self.sources.preview(self.id,self.record['id'])
        self.sources.reject(self.id,self.record['id'])
        with self.assertRaisesRegex(ValueError,'rejected'):self.sources.accept(self.id,self.record['id'])
        self.assertEqual(self.store.word(self.id)['audio_alternative'],{})

    def test_approved_alternative_honours_flags_accents_and_upload_precedence(self):
        self.store.set_audio(self.id,flagged=True)
        word=self.choose()
        self.assertTrue(word['audio_verified']);self.assertFalse(word['audio_flagged'])
        self.assertTrue(word['audio_eligible']);self.assertTrue(audio_eligible(word,self.store.settings()))
        self.assertEqual(self.dictionary.audio(self.id,accent='uk'),self.sources.path(self.record))
        self.store.set_pronunciation(self.id,'uk',{})
        self.assertTrue(self.store.word(self.id)['audio_eligible'])
        with patch.object(self.dictionary,'lookup') as lookup:
            self.assertTrue(self.dictionary.pronunciation(self.id)['chosen']);lookup.assert_not_called()
        self.store.set_audio(self.id,flagged=True)
        with self.assertRaisesRegex(ValueError,'flagged'):self.dictionary.audio(self.id)
        self.assertEqual(self.dictionary.audio(self.id,preview=True),self.sources.path(self.record))
        name='a'*32+'.wav';path=self.store.path.parent/'audio'/name;path.write_bytes(b'RIFFsample')
        self.store.set_audio(self.id,file=name,verified=True,flagged=False)
        self.assertEqual(self.store.word(self.id)['audio_alternative'],{})
        self.assertEqual(self.dictionary.audio(self.id),path)
        with self.assertRaisesRegex(ValueError,'uploaded'):self.sources.accept(self.id,self.record['id'])

    def test_renamed_or_different_word_cannot_accept_stale_offer(self):
        self.offer();other=self.store.add_words([{'word':'high'}])['added'][0]
        with self.assertRaisesRegex(ValueError,'outdated'):self.sources.accept(other,self.record['id'])
        self.choose();self.store.edit_word(self.id,{'word':'highly'})
        self.assertEqual(self.store.word(self.id)['audio_alternative'],{})
        with self.assertRaisesRegex(ValueError,'outdated'):self.sources.accept(self.id,self.record['id'])

    def test_removing_selection_restores_unchecked_cambridge(self):
        self.choose();self.sources.clear(self.id)
        word=self.store.word(self.id)
        self.assertEqual(word['audio_alternative'],{});self.assertFalse(word['audio_verified'])

    def test_backups_keep_provenance_need_rechecking_and_validate_atomically(self):
        word=self.choose();backup=self.store.export()
        other=Store(self.store.path.parent/'restored.db');other.import_backup(backup)
        restored=other.list_words()[0]
        self.assertEqual(restored['audio_alternative'],word['audio_alternative']);self.assertFalse(restored['audio_eligible'])
        for field,value in (('audio_metadata_version',2),('bad_license',True),('bad_media',True),('no_approval',True)):
            bad=copy.deepcopy(backup)
            if field=='bad_license':bad['words'][0]['audio_alternative']['license_url']='https://example.com/license'
            elif field=='bad_media':bad['words'][0]['audio_alternative']['url']='https://127.0.0.1/voice.ogg'
            elif field=='no_approval':bad['words'][0]['audio_alternative'].pop('approved_at')
            else:bad[field]=value
            empty=Store(self.store.path.parent/(field+'.db'))
            with self.assertRaises(ValueError):empty.import_backup(bad)
            self.assertEqual(empty.list_words(),[])
        legacy=copy.deepcopy(backup);legacy.pop('audio_metadata_version');legacy['words'][0].pop('audio_alternative')
        old=Store(self.store.path.parent/'old.db');self.assertEqual(old.import_backup(legacy)['added'],1)

    def test_network_redirect_size_and_audio_content_validation(self):
        self.offer()
        with patch.object(self.network,'request',return_value=self.response(status=302,headers={'Location':'https://127.0.0.1/secrets'})) as request:
            with self.assertRaisesRegex(ValueError,'Unsupported'):self.sources.preview(self.id,self.record['id'])
            self.assertEqual(request.call_count,1)
        for content in (b'<html>not a voice</html>',b'ID3wrong extension',b'x'*(5*1024*1024+1)):
            with patch.object(self.network,'request',return_value=self.response(content)):
                with self.assertRaises(ValueError):self.sources.preview(self.id,self.record['id'])
        self.assertFalse(self.sources.path(self.record).exists())
        invalid={**self.record,'url':'https://upload.wikimedia.org:123/wikipedia/commons/test.ogg'}
        with self.assertRaises(ValueError):validate_record(invalid,'highest')

    def test_provider_failures_are_visible_and_do_not_cache_transport_errors(self):
        with patch.object(self.sources,'fetch',side_effect=NetworkError('private error')):
            self.assertTrue(self.sources.options(self.id,'oxford')['unavailable'])
        with patch.object(self.sources,'fetch',return_value=[]) as fetch:
            self.assertFalse(self.sources.options(self.id,'oxford')['unavailable'])
            self.sources.options(self.id,'oxford');self.assertEqual(fetch.call_count,1)
        self.assertNotIn('private error',str(self.store.logs()))

    def test_parallel_preview_downloads_once_through_shared_network(self):
        self.offer()
        with patch.object(self.network,'request',return_value=self.response()) as request:
            with ThreadPoolExecutor(max_workers=4) as pool:paths=list(pool.map(lambda _:self.sources.preview(self.id,self.record['id']),range(4)))
            self.assertEqual(request.call_count,1)
            self.assertFalse(request.call_args.kwargs['allow_redirects'])
        self.assertTrue(all(path==paths[0] for path in paths))

    def test_http_preview_and_consent_routes_and_csrf(self):
        app=create_app(self.store.path.parent/'web',background=False);client=app.test_client()
        import re
        token=re.search(r'name="typewriter-token" content="([^"]+)"',client.get('/').text).group(1)
        headers={'X-Typewriter-Token':token}
        source=app.extensions['dictionary'].alternatives
        identity=app.extensions['store'].add_words([{'word':'highest'}])['added'][0]
        base=f'/api/words/{identity}/pronunciation/alternatives'
        self.assertEqual(client.post(base,json={'provider':'wiktionary'}).status_code,403)
        with patch.object(source,'fetch',return_value=[self.record]):
            self.assertEqual(client.post(base,json={'provider':'wiktionary'},headers=headers).json['candidates'],[self.record])
        endpoint=base+'/'+self.record['id']
        self.assertEqual(client.post(endpoint+'/accept',json={},headers=headers).status_code,400)
        with patch.object(source.network,'request',return_value=self.response()):
            with client.get(endpoint+'/audio') as response:self.assertEqual(response.data,b'OggSsynthetic')
        self.assertTrue(client.post(endpoint+'/accept',json={},headers=headers).json['audio_eligible'])
        self.assertEqual(client.delete(f'/api/words/{identity}/pronunciation/alternative',headers=headers).json['audio_alternative'],{})
