import tempfile
import unittest
from pathlib import Path
from typewriter.web import create_app


class WebTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        directory = Path(self.directory.name)
        self.app = create_app(directory, directory / "keys.txt", background=False)
        self.client = self.app.test_client()
        # The test requests obtain the same per-process token as the browser page.
        with self.app.test_request_context("/"):
            html = self.app.view_functions["home"]()
        import re
        self.token = re.search(r'name="typewriter-token" content="([^"]+)"', html).group(1)
        self.headers = {"X-Typewriter-Token": self.token}

    def test_end_to_end_local_practice(self):
        response = self.client.post("/api/words", json={"words": [{"word": "necessary"}]}, headers=self.headers)
        self.assertEqual(response.status_code, 201)
        word_id = response.json["added"][0]
        response = self.client.post(f"/api/words/{word_id}/attempts", json={"answer": "neccessary"}, headers=self.headers)
        self.assertFalse(response.json["correct"])
        backup = self.client.get("/api/export").json
        self.assertEqual(len(backup["attempts"]), 1)
        self.assertNotIn("settings", backup)

    def test_external_site_cannot_change_or_read_data(self):
        response = self.client.post("/api/words", json={"words": [{"word": "different"}]})
        self.assertEqual(response.status_code, 403)
        response = self.client.get("/api/state", headers={"Origin": "https://other.example"})
        self.assertEqual(response.status_code, 403)

    def test_api_keys_are_never_returned(self):
        secret = "fake-secret-key-for-browser-test"
        response = self.client.put("/api/keys", json={"keys": secret}, headers=self.headers)
        self.assertEqual(response.json, {"count": 1})
        self.assertNotIn(secret, self.client.get("/api/state").text)
        self.assertNotIn(secret, self.client.get("/api/export").text)
        self.assertEqual(self.client.get("/api_keys.txt").status_code, 404)

    def test_log_download_only_exposes_curated_events(self):
        self.app.extensions["store"].log("info", "Preparation started for 5 words.")
        response = self.client.get("/api/logs/export")
        self.assertEqual(response.status_code, 200)
        self.assertIn("Preparation started for 5 words.", response.text)
        self.assertIn("typewriter-log.txt", response.headers["Content-Disposition"])
        self.assertEqual(len(self.client.get("/api/state").json["logs"]), 1)

    def test_upload_replaces_flagged_audio_and_validates_content(self):
        import io,wave
        response=self.client.post('/api/words',json={'words':[{'word':'highest'}]},headers=self.headers)
        word_id=response.json['added'][0]
        self.client.patch(f'/api/words/{word_id}/audio',json={'flagged':True},headers=self.headers)
        bad=self.client.post(f'/api/words/{word_id}/audio',data={'audio':(io.BytesIO(b'not an audio file'),'bad.mp3')},headers=self.headers)
        self.assertEqual(bad.status_code,400)
        clip=io.BytesIO()
        with wave.open(clip,'wb') as audio:
            audio.setparams((1,2,8000,0,'NONE','not compressed'));audio.writeframes(b'\x00\x00'*800)
        content=clip.getvalue()
        response=self.client.post(f'/api/words/{word_id}/audio',data={'audio':(io.BytesIO(content),'voice.wav')},headers=self.headers)
        self.assertTrue(response.json['audio_eligible'])
        self.assertFalse(response.json['audio_flagged'])
        self.app.extensions['store'].edit_word(word_id,{'source':'Cambridge','audio_url':'https://dictionary.cambridge.org/other.mp3'})
        self.assertTrue(self.app.extensions['store'].word(word_id)['audio_eligible'])
        with self.client.get(f'/api/words/{word_id}/audio') as response:
            self.assertEqual(response.data,content)
        self.client.patch(f'/api/words/{word_id}/audio',json={'flagged':True},headers=self.headers)
        self.assertEqual(self.client.get(f'/api/words/{word_id}/audio').status_code,400)
        with self.client.get(f'/api/words/{word_id}/audio?preview=1') as response:
            self.assertEqual(response.data,content)

    def test_prompt_export_roundtrip_works_without_api_keys(self):
        import io,json,zipfile
        self.client.post('/api/words',json={'words':[{'word':'highest'}]},headers=self.headers)
        response=self.client.post('/api/preparation/export',json={'size':1},headers=self.headers)
        self.assertEqual(response.status_code,200)
        with zipfile.ZipFile(io.BytesIO(response.data)) as archive:
            text=archive.read(next(n for n in archive.namelist() if n!='README.md')).decode()
        payload=json.loads(text.split('```json\n')[1].split('\n```')[0])
        payload['words'][0].update(definition='Above all others.',sentence='This is the highest point.',tip='High + est.')
        reply={'text':json.dumps(payload)}
        self.assertEqual(self.client.post('/api/preparation/preview',json=reply,headers=self.headers).status_code,200)
        self.assertEqual(self.client.post('/api/preparation/import',json=reply,headers=self.headers).json['updated'],1)

    def test_only_versioned_successful_audio_can_be_cached_privately(self):
        store=self.app.extensions['store']
        word_id=store.add_words([{'word':'necessary'}])['added'][0]
        directory=store.path.parent/'audio';directory.mkdir()
        name='a'*32+'.mp3';(directory/name).write_bytes(b'ID3sample')
        store.set_audio(word_id,file=name,verified=True)
        original=store.word(word_id)['audio_revision']
        url=f'/api/words/{word_id}/audio?accent=uk&v={original}'
        with self.client.get(url) as response:
            self.assertEqual(response.status_code,200)
            self.assertIn('private',response.headers['Cache-Control'])
            self.assertIn('max-age=86400',response.headers['Cache-Control'])
            etag=response.headers['ETag']
        with self.client.get(url,headers={'If-None-Match':etag}) as response:
            self.assertEqual(response.status_code,304)
        with self.client.get(f'/api/words/{word_id}/audio') as response:
            self.assertEqual(response.headers['Cache-Control'],'no-store')
        name='b'*32+'.mp3';(directory/name).write_bytes(b'ID3replacement')
        store.set_audio(word_id,file=name,verified=True)
        self.assertNotEqual(store.word(word_id)['audio_revision'],original)
        store.set_audio(word_id,flagged=True)
        with self.client.get(url) as response:
            self.assertEqual(response.status_code,400)
            self.assertEqual(response.headers['Cache-Control'],'no-store')
