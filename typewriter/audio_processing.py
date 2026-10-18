"""Disk-cached pronunciation loudness, with one bounded FFmpeg job at a time."""
import hashlib
import json
import math
import re
import shutil
import subprocess
import tempfile
from collections import OrderedDict
from pathlib import Path
from threading import Lock,Semaphore

VERSION='voice-loudness-v2'


class AudioProcessing:
    def __init__(self,store):
        self.store=store;self.worker=Semaphore(1);self.failed=OrderedDict();self.lock=Lock()
        self.ffmpeg=shutil.which('ffmpeg')

    def snapshot(self):return {'available':bool(self.ffmpeg),'target_lufs':-18}

    def command(self,source,filters,destination):
        command=[self.ffmpeg,'-nostdin','-hide_banner','-nostats','-threads','1','-filter_threads','1','-protocol_whitelist','file,pipe','-i',str(source),'-map','0:a:0','-vn','-sn','-dn','-af',filters]
        if destination:command+=['-map_metadata','-1','-ar','44100','-ac','1','-c:a','libmp3lame','-q:a','4','-y',str(destination)]
        else:command+=['-f','null','-']
        # Decoder messages can grow on corrupt input; keep them on disk and read a bounded tail.
        with tempfile.TemporaryFile() as errors:
            result=subprocess.run(command,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=errors,timeout=30,check=False)
            errors.seek(0,2);errors.seek(max(0,errors.tell()-65536));text=errors.read().decode('utf-8',errors='replace')
        if result.returncode:raise ValueError('Audio could not be decoded.')
        return text

    def normalize(self,source):
        source=Path(source)
        if not self.ffmpeg:return source
        digest=hashlib.sha256(VERSION.encode())
        with source.open('rb') as file:
            for block in iter(lambda:file.read(65536),b''):digest.update(block)
        identity=digest.hexdigest();directory=self.store.path.parent/'audio'/'normalized';destination=directory/(identity+'.mp3')
        if destination.is_file():return destination
        with self.lock:
            if identity in self.failed:return source
        with self.worker:
            if destination.is_file():return destination
            with self.lock:
                if identity in self.failed:return source
            temporary=None
            try:
                measured=self.command(source,'aformat=channel_layouts=mono,loudnorm=I=-18:TP=-1.5:LRA=7:print_format=json',None)
                blocks=re.findall(r'\{[^{}]*"input_i"[^{}]*\}',measured)
                data=json.loads(blocks[-1]) if blocks else {}
                fields=('input_i','input_tp','input_lra','input_thresh','target_offset')
                if data and all(math.isfinite(float(data[field])) for field in fields):
                    filters='aformat=channel_layouts=mono,loudnorm=I=-18:TP=-1.5:LRA=7:linear=true:'+':'.join(key+'='+data[field] for key,field in zip(('measured_I','measured_TP','measured_LRA','measured_thresh','offset'),fields))
                else:
                    # Very short syllables and silence may not have an integrated LUFS value.
                    measured=self.command(source,'aformat=channel_layouts=mono,volumedetect',None)
                    mean=re.search(r'mean_volume:\s*(-?[\d.]+) dB',measured);peak=re.search(r'max_volume:\s*(-?[\d.]+) dB',measured)
                    gain=min(-18-float(mean[1]),-1.5-float(peak[1]),30) if mean and peak else 0
                    filters=f'aformat=channel_layouts=mono,volume={gain:.3f}dB'
                # Trim only near-silence after level adjustment, preserving a short natural lead-in.
                # Silent clips are left intact rather than producing a header-only MP3.
                if math.isfinite(float(data.get('input_tp','-inf'))) and float(data['input_tp'])>-70:
                    filters+=',silenceremove=start_periods=1:start_duration=0.03:start_threshold=-60dB:start_silence=0.04'
                directory.mkdir(parents=True,exist_ok=True)
                with tempfile.NamedTemporaryFile(dir=directory,suffix='.mp3',delete=False) as output:temporary=Path(output.name)
                self.command(source,filters,temporary)
                if temporary.stat().st_size<32:raise ValueError('Empty normalized audio.')
                temporary.chmod(0o600);temporary.replace(destination)
                return destination
            except (OSError,ValueError,KeyError,subprocess.SubprocessError):
                with self.lock:
                    self.failed[identity]=True
                    while len(self.failed)>64:self.failed.popitem(last=False)
                self.store.log('warning','A pronunciation could not be normalized; the original recording is still available.')
                return source
            finally:
                if temporary:temporary.unlink(missing_ok=True)
