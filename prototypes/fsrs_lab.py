"""Deterministic, synthetic scheduling lab. Never opens a production notebook."""
import argparse
import json
from datetime import datetime, timedelta, timezone
from importlib.metadata import version

from fsrs import Card, Rating, Scheduler

LIBRARY = '6.3.2'
SCHEMA = 1


def utc(value):
    if value.tzinfo is None:
        raise ValueError('A timezone-aware instant is required.')
    return value.astimezone(timezone.utc)


class Lab:
    """Candidate shadow-state policy, deliberately isolated from Typewriter."""
    def __init__(self):
        if version('fsrs') != LIBRARY:
            raise ValueError('Use the pinned prototype requirements.')
        self.scheduler = Scheduler(desired_retention=0.9, enable_fuzzing=False)
        self.active = 'legacy'
        self.words = {}
        self.events = []
        self.switches = []

    def add(self, word_id, at):
        at = utc(at)
        if word_id in self.words:
            raise ValueError('Word already exists.')
        self.words[word_id] = {'stage':0,'due':at,'last_success_day':None,'reset':at,
                              'spelling':Card(card_id=word_id*2,due=at),
                              'meaning':Card(card_id=word_id*2+1,due=at)}

    def due(self, word_id, mode=None):
        word = self.words[word_id]
        return word['due'] if (mode or self.active)=='legacy' else word['spelling'].due

    def observe(self, word_id, at, *, correct, hinted=False, mode='review', context='normal', exercise='sentence'):
        at = utc(at)
        if mode not in ('review','meaning','drill','correction') or context not in ('normal','selected','endless','drill','unknown'):
            raise ValueError('Unknown event context.')
        word = self.words[word_id]
        if at < word['reset'] or any(e['word_id']==word_id and datetime.fromisoformat(e['at'])>at for e in self.events):
            raise ValueError('Review history must be chronological and after reset.')
        due_before = self.due(word_id)
        event = {'word_id':word_id,'at':at.isoformat(),'correct':correct,'hinted':hinted,
                 'mode':mode,'context':context,'exercise':exercise,'active':self.active}
        # Legacy comparator follows the approved due-only success policy.
        if mode=='review':
            if correct and not hinted:
                if due_before<=at and word['due']<=at and word['last_success_day'] != at.date().isoformat():
                    word['stage']=min(5,word['stage']+1)
                    word['last_success_day']=at.date().isoformat()
                    word['due']=at+timedelta(days=[1,1,3,7,14,30][word['stage']])
            else:
                word['stage']=max(0,word['stage']-1)
                word['due']=at+timedelta(minutes=10)
        # Candidate FSRS policy: independent scheduled evidence only. Not production.
        target = 'meaning' if mode=='meaning' else 'spelling'
        scheduled = word['meaning'].due <= at if mode=='meaning' else due_before <= at
        accepted = mode in ('review','meaning') and context in ('normal','selected','endless') and scheduled
        if accepted:
            rating=Rating.Good if correct and not hinted else Rating.Again
            word[target], _ = self.scheduler.review_card(word[target],rating,review_datetime=at)
            event['rating']=int(rating)
        else:
            event['rating']=None
        self.events.append(event)
        return event

    def preview(self, at):
        at = utc(at)
        return {'legacy_due':sum(w['due']<=at for w in self.words.values()),
                'fsrs_due':sum(w['spelling'].due<=at for w in self.words.values()),
                'active':self.active}

    def switch(self, target, at, *, confirm=False, session_active=False):
        if target not in ('legacy','fsrs'):
            raise ValueError('Unknown scheduler.')
        if session_active:
            raise ValueError('End the active session before switching.')
        preview=self.preview(at)
        if confirm and target != self.active:
            self.switches.append({'at':utc(at).isoformat(),'from':self.active,'to':target})
            self.active=target
        return preview

    def reset(self, word_id, at):
        # Historical events stay available; only the new spelling's states restart.
        del self.words[word_id]
        self.add(word_id,at)

    def dump(self):
        words={}
        for key, word in self.words.items():
            words[str(key)]={**word,'due':word['due'].isoformat(),'reset':word['reset'].isoformat(),
                             'spelling':word['spelling'].to_dict(),'meaning':word['meaning'].to_dict()}
        return {'schema':SCHEMA,'library':LIBRARY,'active':self.active,'scheduler':self.scheduler.to_dict(),
                'words':words,'events':self.events,'switches':self.switches}

    @classmethod
    def restore(cls, data):
        if data.get('schema')!=SCHEMA or data.get('library')!=LIBRARY or data.get('active') not in ('legacy','fsrs'):
            raise ValueError('Unsupported laboratory snapshot.')
        lab=cls();lab.active=data['active'];lab.scheduler=Scheduler.from_dict(data['scheduler'])
        if lab.scheduler.enable_fuzzing:
            raise ValueError('Laboratory replay requires deterministic scheduling.')
        lab.events=list(data['events']);lab.switches=list(data['switches'])
        for key, word in data['words'].items():
            lab.words[int(key)]={**word,'due':utc(datetime.fromisoformat(word['due'])),
                                 'reset':utc(datetime.fromisoformat(word['reset'])),
                                 'spelling':Card.from_dict(word['spelling']),
                                 'meaning':Card.from_dict(word['meaning'])}
        return lab


def demonstration():
    base=datetime(2026,10,1,9,tzinfo=timezone.utc)
    lab=Lab()
    for word_id in (1,2,3):lab.add(word_id,base)
    rows=[]
    for day, correct, hinted in [(0,True,False),(1,True,False),(4,False,False),(5,True,True),(6,True,False),(14,True,False)]:
        at=base+timedelta(days=day)
        lab.observe(1,at,correct=correct,hinted=hinted)
        word=lab.words[1]
        rows.append({'day':day,'correct':correct,'hinted':hinted,'legacy_due':word['due'].isoformat(),
                     'fsrs_due':word['spelling'].due.isoformat(),'stability':word['spelling'].stability})
    at=base+timedelta(days=30)
    result={'scope':'Synthetic code checks only; no production data or learning-outcome claim.',
            'library':LIBRARY,'schema':SCHEMA,'history':rows,'preview':lab.preview(at)}
    lab.switch('fsrs',at,confirm=True)
    restored=Lab.restore(json.loads(json.dumps(lab.dump())))
    assert restored.dump()==lab.dump()
    result['snapshot_roundtrip']=True
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    print(json.dumps(demonstration(),indent=2))
