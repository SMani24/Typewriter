import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from typewriter.store import Store
from typewriter.network import Network
from typewriter.models import ModelCatalog, normalize_model
from typewriter.enrichment import Enrichment


class ModelTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store=Store(Path(self.directory.name)/'test.db')
        self.network=Network(self.store)
        self.catalog=ModelCatalog(self.store,self.network)

    def test_normalize_common_name_order_and_reject_non_model(self):
        self.assertEqual(normalize_model(' models/GEMINI-FLASH-3.5 '), 'gemini-3.5-flash')
        self.assertEqual(normalize_model('gemini-flash-lite-3.5'), 'gemini-3.5-flash-lite')
        self.assertEqual(normalize_model('gemini-flash-latest'), 'gemini-flash-latest')
        self.assertEqual(self.store.save_settings({'model':'gemini-flash-3.5'})['model'], 'gemini-3.5-flash')
        with self.assertRaises(ValueError): normalize_model('gemini/secret')

    def test_unavailable_model_does_not_reserve_or_send_generation(self):
        keys=Path(self.directory.name)/'keys.txt';keys.write_text('fake-key-with-no-network-calls')
        worker=Enrichment(self.store,self.network,keys)
        ids=self.store.add_words([{'word':'necessary'}])['added']
        with patch.object(self.network,'request',return_value=Mock(status_code=404)) as request:
            worker.run(ids)
        self.assertEqual(request.call_count,1)
        self.assertEqual(request.call_args.args[0],'GET')
        self.assertEqual(worker.snapshot()['requests_today'],0)
        self.assertIn('No generation request',worker.snapshot()['error'])

    def test_model_metadata_cached_and_generation_support_required(self):
        good=Mock(status_code=200);good.json.return_value={'supportedGenerationMethods':['generateContent']}
        with patch.object(self.network,'request',return_value=good) as request:
            self.catalog.validate('gemini-3.5-flash','local-key')
            self.catalog.validate('gemini-3.5-flash','local-key')
        self.assertEqual(request.call_count,1)
        bad=Mock(status_code=200);bad.json.return_value={'supportedGenerationMethods':['embedContent']}
        with patch.object(self.network,'request',return_value=bad),self.assertRaises(ValueError):
            self.catalog.validate('gemini-embedding-001','local-key')

    def test_rejected_metadata_key_rotates_without_generation_budget(self):
        keys=Path(self.directory.name)/'keys.txt';keys.write_text('first-fake-key-no-network-calls\nsecond-fake-key-no-network-calls')
        worker=Enrichment(self.store,self.network,keys);worker.pool.pace=Mock()
        ids=self.store.add_words([{'word':'necessary'}])['added']
        rejected=Mock(status_code=403)
        metadata=Mock(status_code=200);metadata.json.return_value={'supportedGenerationMethods':['generateContent']}
        generated=Mock(status_code=200);generated.json.return_value={'candidates':[{'content':{'parts':[{'text':'{"words":[]}'}]}}]}
        with patch.object(self.network,'request',side_effect=[rejected,metadata,generated]) as request:
            worker.run(ids)
        self.assertEqual([call.args[0] for call in request.call_args_list],['GET','GET','POST'])
        self.assertEqual(worker.snapshot()['requests_today'],1)

    def test_paginated_catalog_only_returns_text_models(self):
        first=Mock(status_code=200);first.json.return_value={'models':[{'name':'models/gemini-3.5-flash','supportedGenerationMethods':['generateContent']}],'nextPageToken':'next-page'}
        second=Mock(status_code=200);second.json.return_value={'models':[{'name':'models/gemini-embedding-001','supportedGenerationMethods':['embedContent']}]}
        with patch.object(self.network,'request',side_effect=[first,second]) as request:
            self.assertEqual(self.catalog.list('local-key'),['gemini-3.5-flash'])
        self.assertEqual(request.call_args.kwargs['params']['pageToken'],'next-page')
