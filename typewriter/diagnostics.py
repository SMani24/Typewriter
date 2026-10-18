"""Bounded failure records containing locations, never exception values or user text."""
import json
import logging
import re
import sys
import threading
import traceback
import uuid
from collections import deque
from datetime import datetime,timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from time import monotonic

ROOT=Path(__file__).resolve().parent.parent


class Diagnostics:
    def __init__(self,directory):
        directory=Path(directory);directory.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.path=directory/'diagnostics.log';self.lock=threading.Lock();self.events=deque(maxlen=30)
        self.handler=RotatingFileHandler(self.path,maxBytes=256*1024,backupCount=2,encoding='utf-8',delay=True)

    def record(self,kind,**fields):
        stamp=monotonic()
        with self.lock:
            if len(self.events)==30 and stamp-self.events[0]<60:return None
            self.events.append(stamp)
            event={'id':uuid.uuid4().hex[:12],'created':datetime.now(timezone.utc).isoformat(),'kind':kind,**fields}
            try:
                # Bound permissions before writing; rotated files inherit this mode.
                self.path.touch(mode=0o600,exist_ok=True);self.path.chmod(0o600)
                self.handler.emit(logging.makeLogRecord({'msg':json.dumps(event),'levelno':logging.ERROR,'levelname':'ERROR'}))
                self.path.chmod(0o600)
            except OSError:return None
            finally:self.handler.close()
            return event['id']

    def exception(self,error,kind='server'):
        frames=[]
        for frame in traceback.extract_tb(error.__traceback__)[-12:]:
            path=Path(frame.filename)
            try:name=str(path.resolve().relative_to(ROOT))
            except ValueError:name=path.name
            frames.append({'file':name,'line':frame.lineno,'function':frame.name})
        return self.record(kind,error_type=type(error).__name__,frames=frames)

    def browser(self,data):
        if data.get('kind') not in ('error','unhandledrejection','playback-timeout'):raise ValueError('Invalid diagnostic event.')
        source=data.get('source','')
        if not isinstance(source,str) or source and (not re.fullmatch(r'[a-z_]+\.js',source) or not (ROOT/'static'/source).is_file()):raise ValueError('Invalid diagnostic source.')
        location={}
        for key in ('line','column'):
            value=data.get(key,0)
            if type(value) is not int or not 0<=value<=1000000:raise ValueError('Invalid diagnostic location.')
            location[key]=value
        # Ignore supplied messages/stacks entirely; they can contain notebook contents.
        return self.record('browser',event=data['kind'],source=source,**location)

    def export(self):
        with self.lock:
            files=[self.path.with_name(self.path.name+suffix) for suffix in ('.2','.1','')]
            return '\n'.join(p.read_text(errors='replace') for p in files if p.is_file())

    def install_hooks(self):
        def failed(error,kind):
            identity=self.exception(error,kind)
            print(f'Typewriter failure recorded locally. Reference: {identity or "unavailable"}.',file=sys.stderr)
        sys.excepthook=lambda cls,error,tb:sys.__excepthook__(cls,error,tb) if issubclass(cls,KeyboardInterrupt) else failed(error,'process')
        threading.excepthook=lambda args:failed(args.exc_value,'thread')
