import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from typewriter.store import Store
from typewriter.preparation import Preparation


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = Store(Path(self.directory.name) / 'test.db')
        self.ids = self.store.add_words([{'word':'necessary'}, {'word':'different'}, {'word':'environment'}])['added']
        self.preparation = Preparation(self.store)

    def reply(self, prompt):
        sample = prompt.split('```json\n')[1].split('\n```')[0]
        payload = json.loads(sample)
        for w in payload['words']:
            w.update(definition='A useful meaning.', sentence=f"Practise the word {w['word']} today.", tip='Notice the letters carefully.')
        return payload

    def export(self, size=2):
        stream, name = self.preparation.export(size=size)
        archive = zipfile.ZipFile(stream)
        prompts = [archive.read(n).decode() for n in archive.namelist() if n != 'README.md']
        return name, prompts

    def test_unique_prompt_batches_and_complete_round_trip(self):
        name, prompts = self.export()
        self.assertNotEqual(name, self.export()[0])
        self.assertEqual(len(prompts), 2)
        sizes = []
        for prompt in prompts:
            text = 'Here is your response:\n```json\n' + json.dumps(self.reply(prompt)) + '\n```'
            preview = self.preparation.preview(text)
            sizes.append(len(preview['words']))
            result = self.preparation.apply(text)
            self.assertEqual(result['updated'], len(preview['words']))
            self.assertEqual(self.preparation.apply(text)['updated'], 0)
        self.assertEqual(sizes, [2, 1])
        self.assertTrue(all(w['status']=='ready' for w in self.store.list_words()))
        self.assertEqual(self.store.list_words()[0]['sources']['definition'], 'External LLM')

    def test_invalid_late_entry_cannot_change_any_words(self):
        _, prompts = self.export()
        payload = self.reply(prompts[0])
        payload['words'][-1]['sentence'] = 'The exact spelling is absent.'
        with self.assertRaises(ValueError):
            self.preparation.apply(json.dumps(payload))
        self.assertTrue(all(not w['definition'] for w in self.store.list_words()))

    def test_manual_edits_deleted_words_and_partial_replies_are_preserved(self):
        _, prompts = self.export(3)
        payload = self.reply(prompts[0])
        word = payload['words'][0]['word']
        word_id = next(w['id'] for w in self.store.list_words() if w['word']==word)
        self.store.edit_word(word_id, {'definition':'My own meaning.'})
        removed = self.store.list_words()[1]
        self.store.delete_word(removed['id'])
        payload['words'] = [w for w in payload['words'] if w['word'] != removed['word']]
        text = json.dumps(payload)
        self.assertEqual(self.preparation.preview(text)['missing'], 1)
        self.preparation.apply(text)
        self.assertEqual(self.store.word(word_id)['definition'], 'My own meaning.')

    def test_unknown_batch_unexpected_word_and_duplicates_rejected(self):
        _, prompts = self.export()
        original = self.reply(prompts[0])
        for change in ('batch', 'word', 'duplicate'):
            payload=json.loads(json.dumps(original))
            if change=='batch': payload['batch_id']='0'*32
            if change=='word': payload['words'][0]['word']='unrelated'
            if change=='duplicate': payload['words'].append(payload['words'][0])
            with self.assertRaises(ValueError): self.preparation.apply(json.dumps(payload))

    def test_selected_export_and_offline_mode_do_not_use_keys(self):
        self.store.save_settings({'preparation_method':'offline'})
        stream, _ = self.preparation.export([self.ids[0]], 1)
        with zipfile.ZipFile(stream) as archive:
            prompt = archive.read(next(n for n in archive.namelist() if n!='README.md')).decode()
        self.assertEqual([w['word'] for w in self.reply(prompt)['words']], ['necessary'])

    def test_bom_and_markdown_with_inline_closing_fence_are_accepted(self):
        _,prompts=self.export()
        text=json.dumps(self.reply(prompts[0]))
        for reply in ('\ufeff'+text,'Here is the reply:\r\n```JSON\r\n'+text+'```'):
            self.assertEqual(len(self.preparation.preview(reply)['words']),2)

    def test_validation_identifies_the_word_field_and_json_location(self):
        _,prompts=self.export()
        payload=self.reply(prompts[0]);word=payload['words'][0]['word']
        payload['words'][0]['sentence']='This sentence omits the target.'
        with self.assertRaisesRegex(ValueError,word+': the sentence'):
            self.preparation.preview(json.dumps(payload))
        payload=self.reply(prompts[0]);payload['words'][0]['distractors']=['Only one']
        with self.assertRaisesRegex(ValueError,word+': Quiz options'):
            self.preparation.preview(json.dumps(payload))
        with self.assertRaisesRegex(ValueError,'line 1, column'):
            self.preparation.preview('{invalid}')
        self.assertFalse(any(w['definition'] for w in self.store.list_words()))

    def test_full_re_evaluation_batch_uses_one_notebook_snapshot(self):
        from unittest.mock import patch
        words=[{'word':f'word{chr(97+i//26)}{chr(97+i%26)}','definition':'Original meaning.','sentence':f'Practise word{chr(97+i//26)}{chr(97+i%26)} today.','tip':'Original tip.'} for i in range(100)]
        ids=self.store.add_words(words)['added']
        stream,_=self.preparation.export(ids,size=100,re_evaluate=True)
        with zipfile.ZipFile(stream) as archive:
            prompt=archive.read(next(n for n in archive.namelist() if n!='README.md')).decode()
        reply=json.dumps(self.reply(prompt))
        with patch.object(self.store,'list_words',wraps=self.store.list_words) as snapshot:
            preview=self.preparation.preview(reply)
            snapshot.assert_called_once()
        self.assertEqual(len(preview['words']),100)
        self.assertTrue(all(w['replace'] for w in preview['words']))
        self.assertEqual(self.preparation.apply(reply)['updated'],100)
        self.assertTrue(all(w['stale'] for w in self.preparation.preview(reply)['words']))
        self.assertNotIn('proxy_host', prompt)
        self.assertNotIn('api_key', prompt)
