"""Versioned spelling scheduling. Meaning quizzes deliberately keep their own ranking."""
import hashlib
import json
import math
import secrets
from datetime import datetime, timedelta, timezone
from importlib.metadata import version

from fsrs import Card, Rating, Scheduler

LIBRARY = '6.3.2'
POLICY = 1
CONFIG = {'library': LIBRARY, 'policy': POLICY, 'desired_retention': 0.9, 'enable_fuzzing': False}
CONFIG_ID = hashlib.sha256(json.dumps(CONFIG, sort_keys=True).encode()).hexdigest()
SESSION_SECONDS = 180  # Renewed by the open practice tab; expired sessions cannot resume.


def utc(value):
    parsed = datetime.fromisoformat(value) if isinstance(value, str) else value
    if parsed.tzinfo is None:
        raise ValueError('Scheduling dates must include a timezone.')
    return parsed.astimezone(timezone.utc)


def adapter():
    if version('fsrs') != LIBRARY:
        raise ValueError('Install Typewriter requirements before using this scheduler.')
    return Scheduler(desired_retention=0.9, enable_fuzzing=False)


def card_for(db, word):
    row = db.execute('SELECT * FROM spelling_schedules WHERE word_id=?', (word['id'],)).fetchone()
    if row:
        if row['config'] != CONFIG_ID or row['version'] != 1:
            raise ValueError('Unsupported saved scheduler state. Restore with a compatible Typewriter version.')
        return Card.from_dict(json.loads(row['card']))
    return Card(card_id=word['id'], due=utc(word['recall_reset_at'] or word['created']))


def save_card(db, card, cursor=0):
    db.execute('INSERT OR REPLACE INTO spelling_schedules (word_id,version,config,card,cursor) VALUES (?,1,?,?,?)',
               (card.card_id, CONFIG_ID, json.dumps(card.to_dict()), cursor))


def engine(db):
    row = db.execute("SELECT value FROM settings WHERE name='scheduler'").fetchone()
    return json.loads(row['value']) if row else 'legacy'


def audio_eligible(word, settings):
    accent=word['pronunciation_accent'] or settings['pronunciation_accent']
    recording=word['audio_urls'].get(accent) if word['audio_urls'] else word['audio_url'] if accent=='uk' else ''
    return bool(word['audio_verified'] and not word['audio_flagged'] and (word['audio_file'] or word.get('audio_alternative') or recording))


def spelling_types(word, settings):
    if word.get("practice_ready") is False:return []
    return [name for name, ready in (
        ('sentence', bool(word['clue'])),
        ('definition', bool(word['definition'] and not word['meaning_flagged'])),
        ('audio', audio_eligible(word,settings) and (not settings.get('audio_pause_until') or utc(settings['audio_pause_until'])<=datetime.now(timezone.utc)))) if ready and settings[name+'_enabled']]


def order_key(word, selected):
    due = utc(word['due'])
    if selected == 'fsrs':
        # New cards are explicit, uncalibrated; oldest new cards first, then recall risk.
        return (0 if word['retrievability'] is None else 1,
                word['retrievability'] or 0, due, word['id'])
    return (-word['review_priority'], due, word['id'])


class SchedulingStore:
    def audio_pause_until(self):
        with self.db() as db:row=db.execute("SELECT value FROM cache WHERE name='audio-pause-until'").fetchone()
        value=json.loads(row['value']) if row else ''
        return value if value and utc(value)>datetime.now(timezone.utc) else ''

    def pause_audio(self,resume=False):
        if type(resume) is not bool:raise ValueError('Choose pause or resume.')
        until='' if resume else (datetime.now(timezone.utc)+timedelta(minutes=self.settings()['audio_pause_minutes'])).isoformat()
        with self.db() as db:db.execute("INSERT OR REPLACE INTO cache VALUES ('audio-pause-until',?)",(json.dumps(until),))
        return until

    def init_scheduling(self, db):
        db.executescript('''
            CREATE TABLE IF NOT EXISTS spelling_schedules (
                word_id INTEGER PRIMARY KEY REFERENCES words(id) ON DELETE CASCADE,
                version INTEGER NOT NULL, config TEXT NOT NULL, card TEXT NOT NULL,
                cursor INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS practice_sessions (
                id TEXT PRIMARY KEY, engine TEXT NOT NULL, config TEXT NOT NULL,
                settings TEXT NOT NULL, kind TEXT NOT NULL, scope TEXT,
                remaining TEXT NOT NULL, offered TEXT NOT NULL, expires TEXT NOT NULL,
                ended INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS practice_answers (
                session_id TEXT NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE,
                request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL,
                PRIMARY KEY (session_id,request_id)
            );
            CREATE TABLE IF NOT EXISTS scheduler_switches (
                id INTEGER PRIMARY KEY, created TEXT NOT NULL, previous TEXT NOT NULL,
                selected TEXT NOT NULL, config TEXT NOT NULL
            );
        ''')
        # No ambiguous pre-upgrade events are replayed. Cards begin new, with Legacy intact.
        for word in db.execute('SELECT * FROM words WHERE id NOT IN (SELECT word_id FROM spelling_schedules)').fetchall():
            cursor=db.execute('SELECT COALESCE(MAX(id),0) FROM attempts WHERE word_id=?',(word['id'],)).fetchone()[0]
            save_card(db, card_for(db, word),cursor)
        db.execute("INSERT OR IGNORE INTO cache VALUES ('coverage-position','0')")
        db.execute("INSERT OR IGNORE INTO cache VALUES ('evidence-start',?)", (json.dumps(datetime.now(timezone.utc).isoformat()),))

    @staticmethod
    def active_sessions(db, at):
        return db.execute('SELECT 1 FROM practice_sessions WHERE ended=0 AND expires>? LIMIT 1', (at.isoformat(),)).fetchone()

    def session_row(self, db, token, at):
        row = db.execute('SELECT * FROM practice_sessions WHERE id=?', (token,)).fetchone() if isinstance(token,str) else None
        if not row or row['ended'] or utc(row['expires']) <= at:
            raise ValueError('This practice session ended or expired. Start a new session; saved answers are kept.')
        if row['engine'] != engine(db) or row['config'] != CONFIG_ID:
            raise ValueError('The scheduler changed. Start a new session.')
        return row

    def validate_session_answer(self, db, data, word, metadata, at):
        selected = engine(db)
        if not data.get('session_id'):
            # Compatibility for local API clients. They may not bypass an open session.
            if selected != 'legacy' or self.active_sessions(db, at):
                raise ValueError('Start a practice session before answering.')
            return selected
        session = self.session_row(db,data['session_id'],at)
        kind = session['kind']
        if metadata['session_kind'] != kind:
            raise ValueError('This answer does not match the saved practice session.')
        scope = json.loads(session['scope'])
        if scope is not None and word['id'] not in scope:
            raise ValueError('This word is outside the saved practice selection.')
        if kind=='drill' and data.get('mode')!='drill' or kind!='drill' and data.get('mode')=='drill':
            raise ValueError('This answer does not match the saved practice mode.')
        if data.get('mode','review') in ('review','correction') and kind == 'normal' and word['id'] not in json.loads(session['offered']):
            raise ValueError('This word was not offered in this review session.')
        settings = json.loads(session['settings'])
        if metadata['exercise'] == 'unknown':
            raise ValueError('Choose a saved exercise for this practice session.')
        if metadata['exercise'] != 'unknown' and not settings.get(metadata['exercise']+'_enabled',False):
            raise ValueError('This exercise was disabled when the session began.')
        if data.get('mode','review')=='review':
            current=self.word(word['id'])
            if metadata['exercise'] not in spelling_types(current,settings):
                raise ValueError('This spelling clue is no longer available. Skip it or start a new session.')
        db.execute('UPDATE practice_sessions SET expires=? WHERE id=?', ((at+timedelta(seconds=SESSION_SECONDS)).isoformat(),session['id']))
        return selected

    def start_session(self, data):
        kind = data.get('kind','normal')
        scope = data.get('ids')
        if kind not in ('normal','selected','endless','drill') or scope is not None and (not isinstance(scope,list) or len(scope)>10000 or any(type(i) is not int for i in scope)):
            raise ValueError('Choose a valid practice session.')
        if kind in ('selected','drill') and not scope:
            raise ValueError('Choose words for this practice session.')
        settings = self.settings()
        if not settings['drill_enabled' if kind=='drill' else 'review_enabled']:
            raise ValueError('This practice mode is disabled.')
        at = datetime.now(timezone.utc)
        token = secrets.token_urlsafe(24)
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            if self.active_sessions(db,at):
                raise ValueError('A practice session is already open. End it in the other tab, or wait three minutes after closing that tab.')
            settings = self.settings()
            settings['audio_pause_until']=self.audio_pause_until()
            selected = engine(db)
            # list_words uses the same committed revision; this transaction excludes writers.
            candidates = [w for w in self.list_words() if scope is None or w['id'] in scope]
            if kind=='drill' and any(not w.get('practice_ready',True) for w in candidates):raise ValueError('Finish preparing this word before starting a drill.')
            spellable = [w for w in candidates if spelling_types(w,settings)]
            due = [w for w in spellable if w['is_due']]
            pool = (due or spellable) if kind=='endless' else spellable if kind=='selected' else due
            if data.get('meaning_only') or kind=='drill':
                pool = []
            limit = 10 if kind=='endless' else len(pool) if kind=='selected' else (settings['review_session_size'] or len(pool))
            if kind == 'normal':
                # Reserve capacity, but choose each actual displayed position at current credit.
                remaining = [w['id'] for w in pool]
                queue = sorted(pool,key=lambda w:order_key(w,selected))[:limit]
            else:
                queue = sorted(pool,key=lambda w:order_key(w,selected))[:limit]
                remaining = []
            db.execute('DELETE FROM practice_sessions WHERE ended=1 OR expires<=?', (at.isoformat(),))
            db.execute('INSERT INTO practice_sessions VALUES (?,?,?,?,?,?,?,?,?,0)', (token,selected,CONFIG_ID,json.dumps(settings),kind,json.dumps(scope),json.dumps(remaining),json.dumps([]),(at+timedelta(seconds=SESSION_SECONDS)).isoformat()))
            if kind=='normal' and queue:
                first = self._offer(db,token,at, candidates)
                queue = [first]+[w for w in queue if w['id'] != first['id']]
                queue = queue[:limit]
            return {'id':token,'scheduler':selected,'config':CONFIG_ID,'settings':settings,'words':queue}

    def _offer(self, db, token, at, words):
        session = self.session_row(db,token,at)
        settings = json.loads(session['settings'])
        settings['audio_pause_until']=self.audio_pause_until()
        offered = json.loads(session['offered'])
        remaining = set(json.loads(session['remaining']))
        if settings['review_session_size'] and len(offered) >= settings['review_session_size']:
            return None
        eligible = [w for w in words if w['id'] in remaining and w['is_due'] and spelling_types(w,settings)]
        if not eligible:
            return None
        row = db.execute("SELECT value FROM cache WHERE name='coverage-position'").fetchone()
        position = int(row['value'])
        key = (lambda w:(utc(w['due']),w['id'])) if (position+1)%5==0 else (lambda w:order_key(w,session['engine']))
        word = min(eligible,key=key)
        offered.append(word['id']);remaining.remove(word['id'])
        db.execute('UPDATE practice_sessions SET offered=?,remaining=?,expires=? WHERE id=?', (json.dumps(offered),json.dumps(sorted(remaining)),(at+timedelta(seconds=SESSION_SECONDS)).isoformat(),token))
        db.execute("UPDATE cache SET value=? WHERE name='coverage-position'",(str((position+1)%5),))
        return word

    def session_next(self, token, position):
        at = datetime.now(timezone.utc)
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            session = self.session_row(db,token,at)
            if session['kind'] != 'normal':
                raise ValueError('Only normal reviews use coverage selection.')
            offered = json.loads(session['offered'])
            if type(position) is not int or not 0<=position<=len(offered):
                raise ValueError('This review position is out of sequence.')
            if position<len(offered):
                return {'word':next((w for w in self.list_words() if w['id']==offered[position]),None)}
            return {'word':self._offer(db,token,at,self.list_words())}

    def session_touch(self, token, end=False):
        at = datetime.now(timezone.utc)
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            if end:
                # Ending is idempotent, even after expiry.
                db.execute('UPDATE practice_sessions SET ended=1 WHERE id=?',(token,))
            else:
                self.session_row(db,token,at)
                db.execute('UPDATE practice_sessions SET expires=? WHERE id=?',((at+timedelta(seconds=SESSION_SECONDS)).isoformat(),token))
        return {'ended':end}

    @staticmethod
    def scheduler_revision(db):
        # Covers materials/audio flags, resets, all answer/state/config/settings revisions.
        digest = hashlib.sha256()
        for query in ('SELECT * FROM words ORDER BY id','SELECT * FROM attempts ORDER BY id',
                      'SELECT * FROM spelling_schedules ORDER BY word_id','SELECT * FROM settings ORDER BY name',
                      "SELECT * FROM cache WHERE name='coverage-position'"):
            for row in db.execute(query):
                digest.update(json.dumps(dict(row),sort_keys=True).encode())
        return digest.hexdigest()

    def scheduler_preview(self, target):
        if target not in ('legacy','fsrs'):
            raise ValueError('Choose Legacy or FSRS.')
        at = datetime.now(timezone.utc)
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            if self.active_sessions(db,at):
                raise ValueError('End your practice session before switching schedulers.')
            settings = self.settings()
            candidates = [w for w in self.list_words() if spelling_types(w,settings)]
            counts = {name:{'due':0,'next_7_days':0,'new':0} for name in ('legacy','fsrs')}
            changes = []
            for word in candidates:
                card = card_for(db,word)
                legacy_due = utc(word['legacy_due'])
                for name,due in (('legacy',legacy_due),('fsrs',card.due)):
                    counts[name]['due'] += int(due<=at)
                    counts[name]['next_7_days'] += int(at<due<=at+timedelta(days=7))
                counts['fsrs']['new'] += int(card.last_review is None)
                if len(changes)<5 and legacy_due != card.due:
                    changes.append({'word':word['word'],'legacy':legacy_due.isoformat(),'fsrs':card.due.isoformat()})
            token = secrets.token_urlsafe(24)
            preview = {'token':token,'target':target,'active':engine(db),'revision':self.scheduler_revision(db),
                       'created':at.isoformat(),'counts':counts,'changes':changes,'config':CONFIG_ID}
            db.execute("INSERT OR REPLACE INTO cache VALUES ('scheduler-preview',?)",(json.dumps(preview),))
        return preview

    def scheduler_switch(self, data):
        at = datetime.now(timezone.utc)
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            if self.active_sessions(db,at):
                raise ValueError('End your practice session before switching schedulers.')
            row = db.execute("SELECT value FROM cache WHERE name='scheduler-preview'").fetchone()
            preview = json.loads(row['value']) if row else None
            if not preview or not isinstance(data.get('token'),str) or not secrets.compare_digest(data['token'],preview['token']) or data.get('target')!=preview['target'] or preview['revision']!=self.scheduler_revision(db) or at-utc(preview['created'])>timedelta(minutes=3):
                raise ValueError('This preview is out of date. Preview the workload again before switching.')
            # Passing time can change eligibility even without a database write.
            words = [w for w in self.list_words() if spelling_types(w,self.settings())]
            current = {'legacy':sum(utc(w['legacy_due'])<=at for w in words),
                       'fsrs':sum(utc(w['fsrs_due'])<=at for w in words)}
            if any(current[name] != preview['counts'][name]['due'] for name in current):
                raise ValueError('Review dates changed since the preview. Preview the workload again.')
            db.execute("INSERT OR REPLACE INTO settings VALUES ('scheduler',?)",(json.dumps(preview['target']),))
            db.execute('INSERT INTO scheduler_switches (created,previous,selected,config) VALUES (?,?,?,?)',(at.isoformat(),preview['active'],preview['target'],CONFIG_ID))
            db.execute("DELETE FROM cache WHERE name='scheduler-preview'")
        return self.settings()

    def export_scheduling(self, db, words):
        states = []
        for word in words:
            row = db.execute('SELECT cursor FROM spelling_schedules WHERE word_id=?',(word['id'],)).fetchone()
            states.append({'word_id':word['id'],'card':card_for(db,word).to_dict(),'cursor':row['cursor'] if row else 0})
        coverage = db.execute("SELECT value FROM cache WHERE name='coverage-position'").fetchone()
        since = db.execute("SELECT value FROM cache WHERE name='evidence-start'").fetchone()
        return {'version':1,'config':CONFIG,'selected':engine(db),'states':states,
                'coverage_position':int(coverage['value']),'evidence_start':json.loads(since['value'])}

    @staticmethod
    def validate_scheduling(data, words, attempts):
        if not isinstance(data,dict) or data.get('version')!=1 or data.get('config')!=CONFIG or data.get('selected') not in ('legacy','fsrs'):
            raise ValueError('Unsupported scheduler backup. Use a compatible Typewriter version.')
        if type(data.get('coverage_position')) is not int or not 0<=data['coverage_position']<5:
            raise ValueError('Invalid coverage state in backup.')
        try:
            utc(data['evidence_start'])
            states = data['states']
            ids = {w['id'] for w in words}
            if not isinstance(states,list) or len(states)!=len(ids) or {s['word_id'] for s in states}!=ids:
                raise ValueError()
            events = {a['id']:a for a in attempts if type(a.get('id')) is int}
            if len(events)!=len(attempts):
                raise ValueError()
            for state in states:
                raw = state['card']
                if raw['card_id'] != state['word_id'] or type(state['cursor']) is not int or state['cursor']<0:
                    raise ValueError()
                if state['cursor'] and (state['cursor'] not in events or events[state['cursor']]['word_id']!=state['word_id']):
                    raise ValueError()
                if raw['state'] not in (1,2,3) or raw['step'] is not None and (type(raw['step']) is not int or not 0<=raw['step']<=1):
                    raise ValueError()
                if raw['state']==2 and raw['step'] is not None or raw['state']!=2 and raw['step'] is None:
                    raise ValueError()
                for key in ('stability','difficulty'):
                    if raw[key] is not None and (type(raw[key]) not in (int,float) or not math.isfinite(raw[key]) or raw[key]<=0):
                        raise ValueError()
                if raw['difficulty'] is not None and not 1<=raw['difficulty']<=10:
                    raise ValueError()
                card = Card.from_dict(raw)
                card.due = utc(card.due)
                if card.last_review:
                    card.last_review = utc(card.last_review)
                    if card.last_review>card.due or card.stability is None or card.difficulty is None:
                        raise ValueError()
                elif card.stability is not None or card.difficulty is not None:
                    raise ValueError()
        except (ValueError,TypeError,KeyError,AttributeError,OverflowError):
            raise ValueError('Invalid scheduler state or event cursor in backup.') from None
        return data

    @staticmethod
    def restore_scheduling(db, data, id_map, attempt_map, full):
        if data:
            for state in data['states']:
                if state['word_id'] not in id_map:
                    continue
                card = Card.from_dict(state['card'])
                card.card_id = id_map[state['word_id']]
                card.due = utc(card.due)
                if card.last_review:
                    card.last_review = utc(card.last_review)
                save_card(db,card,attempt_map.get(state['cursor'],0))
        # Merges never change an existing notebook's engine or coverage credit.
        if full:
            selected = data['selected'] if data else 'legacy'
            db.execute("INSERT OR REPLACE INTO settings VALUES ('scheduler',?)",(json.dumps(selected),))
            if data:
                db.execute("UPDATE cache SET value=? WHERE name='coverage-position'",(str(data['coverage_position']),))
                db.execute("UPDATE cache SET value=? WHERE name='evidence-start'",(json.dumps(data['evidence_start']),))
