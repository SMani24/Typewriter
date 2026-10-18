import hashlib,math,re,shutil,struct,tempfile,unittest,wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
from typewriter.store import Store
from typewriter.audio_processing import AudioProcessing


@unittest.skipUnless(shutil.which('ffmpeg'),'FFmpeg is optional; install it to check normalization')
class AudioProcessingTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.store=Store(Path(self.temp.name)/'test.db');self.audio=AudioProcessing(self.store)

    def tone(self,name,amplitude,duration=1):
        path=Path(self.temp.name)/(name+'.wav')
        with wave.open(str(path),'wb') as output:
            output.setparams((1,2,16000,0,'NONE','not compressed'))
            output.writeframes(b''.join(struct.pack('<h',int(amplitude*math.sin(2*math.pi*440*i/16000))) for i in range(int(16000*duration))))
        return path

    def volume(self,path):
        text=self.audio.command(path,'volumedetect',None)
        return tuple(float(re.search(key+r':\s*(-?[\d.]+) dB',text)[1]) for key in ('mean_volume','max_volume'))

    def test_loud_and_quiet_recordings_converge_without_changing_originals(self):
        quiet=self.tone('quiet',1000);loud=self.tone('loud',12000)
        hashes=[hashlib.sha256(p.read_bytes()).hexdigest() for p in (quiet,loud)]
        normalized=[self.audio.normalize(p) for p in (quiet,loud)]
        self.assertTrue(all(p.suffix=='.mp3' and p.parent.name=='normalized' for p in normalized))
        levels=[self.volume(p) for p in normalized]
        self.assertLess(abs(levels[0][0]-levels[1][0]),1.0)
        self.assertTrue(all(peak<0 for mean,peak in levels))
        self.assertEqual(hashes,[hashlib.sha256(p.read_bytes()).hexdigest() for p in (quiet,loud)])

    def test_short_syllables_and_silence_are_supported(self):
        for amplitude in (0,1000):
            source=self.tone(str(amplitude),amplitude,0.15);result=self.audio.normalize(source)
            self.assertNotEqual(result,source);self.assertGreater(result.stat().st_size,32)

    def test_cache_and_parallel_requests_run_one_conversion(self):
        source=self.tone('source',5000)
        with patch.object(self.audio,'command',wraps=self.audio.command) as command:
            with ThreadPoolExecutor(max_workers=4) as pool:paths=list(pool.map(lambda _:self.audio.normalize(source),range(4)))
            self.assertEqual(command.call_count,2)
            self.assertEqual(self.audio.normalize(source),paths[0]);self.assertEqual(command.call_count,2)
        self.assertTrue(all(p==paths[0] for p in paths))
        source=self.tone('source',1000);self.assertNotEqual(self.audio.normalize(source),paths[0])

    def test_bad_audio_keeps_original_and_failure_cache_is_bounded(self):
        source=Path(self.temp.name)/'bad.mp3';source.write_bytes(b'ID3invalid')
        with patch.object(self.audio,'command',side_effect=ValueError('private decoder detail')) as command:
            for i in range(70):
                source.write_bytes(b'ID3invalid'+str(i).encode());self.assertEqual(self.audio.normalize(source),source)
            self.assertEqual(len(self.audio.failed),64)
            before=command.call_count;self.audio.normalize(source);self.assertEqual(command.call_count,before)
        self.assertNotIn('private decoder detail',str(self.store.logs()))

    def test_missing_ffmpeg_preserves_playback(self):
        source=self.tone('source',5000);self.audio.ffmpeg=None;self.assertEqual(self.audio.normalize(source),source)

    def test_leading_silence_is_trimmed_without_clipping_the_spoken_part(self):
        source=self.tone('padded',5000,duration=0.6)
        with wave.open(str(source),'rb') as file:frames=file.readframes(file.getnframes())
        with wave.open(str(source),'wb') as file:
            file.setparams((1,2,16000,0,'NONE','not compressed'));file.writeframes(b'\0\0'*16000+frames+b'\0\0'*3200)
        digest=hashlib.sha256(source.read_bytes()).hexdigest();result=self.audio.normalize(source)
        text=self.audio.command(result,'silencedetect=n=-45dB:d=0.03',None)
        match=re.search(r'silence_start: 0(?:\.\d+)?\s.*?silence_end: ([\d.]+)',text,re.S)
        if match:self.assertLess(float(match[1]),0.12)
        duration=re.search(r'Duration: (\d+):(\d+):([\d.]+)',text)
        self.assertIsNotNone(duration);self.assertGreater(float(duration[3]),0.65);self.assertLess(float(duration[3]),1.0)
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(),digest)
