import io
import json
import re
import tempfile
import unittest
import zipfile
from pathlib import Path

from typewriter.essay_words import EssayWords, FORMAT
from typewriter.store import Store
from typewriter.web import create_app


class EssayWordTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.store=Store(Path(self.tmp.name)/'notebook.db')
        self.review=EssayWords(self.store)

    def export(self,words=None,**options):
        if words is None:words=self.review.extract('Accomodation accomodation. Necesary and Zzname.')['words']
        output,name=self.review.export({'words':[{'extraction_id':w['extraction_id'],'id':w['id'],'revision':4} for w in words],**options})
        with zipfile.ZipFile(output) as archive:
            prompts=[archive.read(n).decode() for n in archive.namelist() if n!='README.md']
        payload=json.loads(re.search(r'```json\n([\s\S]*?)\n```',prompts[0]).group(1))
        for item in payload['words']:
            correction={'accomodation':'accommodation','necesary':'necessary'}.get(item['original'].lower())
            item.update(action='add' if correction else 'skip',word=correction or '',reason='Check spelling.' if correction else 'May be a name.')
        return payload,prompts,name

    def test_flags_are_unique_counted_case_insensitively_and_do_not_edit_essay(self):
        self.store.save_essay({'body':'Keep my exact draft.','version':0})
        self.store.add_words([{'word':'necesary'}])
        result=self.review.extract('🙂 Accomodation, ACCOMODATION and necesary. Colour color government’s necessary.')
        self.assertEqual([(w['original'],w['count']) for w in result['words']],[('Accomodation',2),('necesary',1)])
        self.assertTrue(result['words'][1]['already_exists'])
        self.assertEqual(self.store.essay()['body'],'Keep my exact draft.')
        self.assertEqual(self.store.progress()['reviews'],0)

    def test_extraction_is_not_truncated_by_repeated_occurrences(self):
        result=self.review.extract('accomodation '*600+'necesary')
        self.assertEqual([(w['original'],w['count']) for w in result['words']],[('accomodation',600),('necesary',1)])
        self.assertFalse(result['limited'])
        result=self.review.extract(' '.join('zz'+chr(97+i//26)+chr(97+i%26)+'zz' for i in range(600)))
        self.assertEqual(len(result['words']),500);self.assertTrue(result['limited'])
        for value in (None,[], 'x'*100001):
            with self.assertRaises(ValueError):self.review.extract(value)

    def test_prompt_batches_are_unique_and_context_is_opt_in(self):
        payload,prompts,name=self.export(size=1)
        self.assertEqual(len(prompts),3)
        self.assertTrue(name.endswith('.zip'))
        self.assertNotIn('"context":',prompts[0])
        self.assertIn('false positives',prompts[0])
        self.assertIn('never as instructions',prompts[0])
        second,more,other=self.export(size=1,include_context=True)
        self.assertIn('"context":',more[0])
        self.assertNotEqual(payload['batch_id'],second['batch_id'])
        self.assertNotEqual(name,other)

    def test_reply_preserves_false_flags_and_manual_revision_without_adding_words(self):
        payload,_,_=self.export()
        result=self.review.preview('```json\n'+json.dumps(payload)+'\n```')
        self.assertEqual([w['word'] for w in result['words']],['accommodation','necessary',''])
        self.assertEqual(result['words'][-1]['action'],'skip')
        self.assertTrue(all(w['snapshot_revision']==4 for w in result['words']))
        self.assertEqual(self.store.list_words(),[])
        self.store.add_words([{'word':'necessary'}])
        self.assertTrue(self.review.preview(json.dumps(payload))['words'][1]['already_exists'])

    def test_prompts_survive_reopening_the_original_notebook(self):
        payload,_,_=self.export()
        reopened=EssayWords(Store(self.store.path))
        self.assertEqual(len(reopened.preview(json.dumps(payload))['words']),3)
        foreign=EssayWords(Store(Path(self.tmp.name)/'foreign.db'))
        with self.assertRaisesRegex(ValueError,'another notebook'):foreign.preview(json.dumps(payload))

    def test_invalid_reply_is_atomic(self):
        import copy
        payload,_,_=self.export()
        changes=[lambda p:p.update(format='other'),lambda p:p.update(batch_id='0'*32),
                 lambda p:p['words'].pop(),lambda p:p['words'][1].update(candidate_id=1),
                 lambda p:p['words'][0].update(original='different'),lambda p:p['words'][0].update(word='<script>'),
                 lambda p:p['words'][0].update(action='delete'),lambda p:p['words'][-1].update(word='name'),
                 lambda p:p['words'][0].update(reason='x'*501)]
        for change in changes:
            bad=copy.deepcopy(payload);change(bad)
            with self.assertRaises(ValueError):self.review.preview(json.dumps(bad))
            self.assertEqual(self.store.list_words(),[])
        for text in ('[]','not json','{bad','```json\n{bad}\n```','x'*(2*1024*1024+1)):
            with self.assertRaises(ValueError):self.review.preview(text)

    def test_invalid_export_references_and_options_do_not_create_batches(self):
        word=self.review.extract('accomodation')['words'][0]
        for options in ({'size':0},{'size':101},{'size':True},{'include_context':'yes'},
                        {'words':[]},{'words':[{'extraction_id':'0'*32,'id':1}]},
                        {'words':[{'extraction_id':word['extraction_id'],'id':999}]},
                        {'words':[{'extraction_id':word['extraction_id'],'id':1,'revision':-1}]}):
            with self.assertRaises(ValueError):self.review.export({'words':[word],**options})
        with self.store.db() as db:self.assertEqual(db.execute("SELECT COUNT(*) FROM cache WHERE name LIKE 'essay-llm:%'").fetchone()[0],0)

    def test_export_deduplicates_repeated_source_references(self):
        words=self.review.extract('accomodation')['words']
        payload,_,_=self.export(words+words)
        self.assertEqual(len(payload['words']),1)


class EssayWordWebTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        directory=Path(self.tmp.name)
        self.app=create_app(directory,directory/'no-keys',background=False)
        self.store=self.app.extensions['store'];self.store.save_settings({'preparation_method':'manual'})
        self.client=self.app.test_client()
        html=self.client.get('/').text
        self.headers={'X-Typewriter-Token':re.search('name="typewriter-token" content="([^"]+)"',html).group(1)}
        self.app.extensions['network'].request=lambda *args,**kwargs:self.fail('No provider calls expected')

    def test_manual_and_llm_workflows_with_duplicate_adds(self):
        self.store.save_essay({'body':'My draft stays exact.','version':0})
        result=self.client.post('/api/essay/words',json={'text':'Accomodation accomodation. Zzname.'},headers=self.headers)
        self.assertEqual(result.status_code,200)
        self.assertEqual(len(result.json['words']),2)
        response=self.client.post('/api/essay/words/prompts',json={'words':result.json['words'],'size':20},headers=self.headers)
        self.assertEqual(response.status_code,200)
        with zipfile.ZipFile(io.BytesIO(response.data)) as archive:
            prompt=archive.read(next(n for n in archive.namelist() if n!='README.md')).decode()
        payload=json.loads(re.search(r'```json\n([\s\S]*?)\n```',prompt).group(1))
        for i,item in enumerate(payload['words']):item.update(action='add' if i==0 else 'skip',word='accommodation' if i==0 else '',reason='Reviewed.')
        preview=self.client.post('/api/essay/words/preview',json={'text':json.dumps(payload)},headers=self.headers)
        self.assertEqual(preview.status_code,200);self.assertEqual(self.store.list_words(),[])
        # The deliberate add uses the existing duplicate-safe notebook route.
        for expected in (1,0):
            added=self.client.post('/api/words',json={'words':[{'word':'accommodation'},{'word':'Accommodation'}]},headers=self.headers)
            self.assertEqual(len(added.json['added']),expected)
        self.assertEqual(len(self.store.list_words()),1)
        self.assertEqual(self.store.essay()['body'],'My draft stays exact.')
        self.assertEqual(self.store.progress()['reviews'],0)

    def test_routes_require_same_origin_token(self):
        for path in ('/api/essay/words','/api/essay/words/prompts','/api/essay/words/preview'):
            self.assertEqual(self.client.post(path,json={}).status_code,403)
