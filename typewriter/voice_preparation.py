"""One bounded background worker for explicitly requested automatic voice choices."""
from threading import Lock,Thread
from .network import NetworkError


class VoicePreparation:
    def __init__(self,store,dictionary):
        self.store,self.dictionary=store,dictionary
        self.lock=Lock();self.busy=False;self.message=''

    def snapshot(self):
        with self.lock:return {'busy':self.busy,'message':self.message}

    def start(self):
        with self.lock:
            if self.busy:return
            ready=any(w['preparation_queue']=='llm_auto' and w['status']=='ready' and not w['sentence_flagged'] and not w['meaning_flagged'] for w in self.store.list_words())
            if not ready:return
            self.busy=True;self.message='Choosing pronunciations for prepared essay words…'
        Thread(target=self.run,daemon=True,name='typewriter-voices').start()

    def run(self):
        try:
            words=[w for w in self.store.list_words() if w['preparation_queue']=='llm_auto' and w['status']=='ready' and not w['sentence_flagged'] and not w['meaning_flagged']]
            for word in words:
                selected=False
                try:
                    if word['audio_file'] or word['audio_alternative'] or word['audio_flagged']:continue
                    try:self.dictionary.pronunciation(word['id'])
                    except (ValueError,NetworkError):pass
                    for provider in ('cambridge','oxford','wiktionary','free_dictionary'):
                        for candidate in self.dictionary.alternatives.options(word['id'],provider)['candidates']:
                            current=self.store.word(word['id'])
                            if not current or current['preparation_queue']!='llm_auto' or current['audio_file'] or current['audio_flagged']:break
                            try:
                                self.dictionary.alternatives.preview(word['id'],candidate['id'])
                                self.dictionary.alternatives.accept(word['id'],candidate['id'],automatic=True)
                                selected=True;break
                            except (ValueError,NetworkError):continue
                        if selected:break
                except Exception:
                    self.store.log('warning','Automatic pronunciation preparation could not finish. Manual voice selection remains available.')
                finally:
                    # A source outage must not permanently block otherwise useful spelling practice.
                    with self.store.db() as db:
                        db.execute("UPDATE words SET preparation_queue='' WHERE id=? AND preparation_queue='llm_auto' AND status='ready' AND meaning_flagged=0 AND sentence_flagged=0",(word['id'],))
                    self.store.log('info','Essay word ready. Automatically chosen recordings need checking before audio-only exercises.' if selected else 'Essay word ready. You can choose or upload a pronunciation in its editor.')
        finally:
            with self.lock:self.busy=False;self.message=''
            self.start()
