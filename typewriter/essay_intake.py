"""Confirmed essay slips and explicit queues, kept separate from quiz evidence."""
import hashlib
import json
import re
from .store import clean_word, now
from .scheduling import card_for,save_card


class EssayIntake:
    def __init__(self,store):self.store=store

    def add(self,data):
        entries=data.get('words');mode=data.get('mode')
        if mode not in ('manual','llm','llm_auto') or not isinstance(entries,list) or not 1<=len(entries)<=500:
            raise ValueError('Choose a preparation queue and 1–500 checked spellings.')
        validated=[]
        with self.store.db() as db:
            for entry in entries:
                if not isinstance(entry,dict) or not isinstance(entry.get('extraction_id'),str) or not re.fullmatch('[a-f0-9]{32}',entry['extraction_id']) or type(entry.get('id')) is not int:
                    raise ValueError('Review the essay flags before adding these words.')
                saved=db.execute('SELECT value FROM cache WHERE name=?',('essay-words:'+entry['extraction_id'],)).fetchone()
                record=json.loads(saved['value']) if saved else {}
                original=next((w for w in record.get('words',[]) if w['id']==entry['id']),None)
                if not original:raise ValueError('A flag belongs to another notebook or is no longer available.')
                word=clean_word(entry.get('word'))
                digest=record.get('text_hash',entry['extraction_id'])
                event=hashlib.sha256((digest+'\0'+original['original'].casefold()+'\0'+word).encode()).hexdigest()
                validated.append((word,original,event))
        added=[];existing=[];marked=[];stamp=now()
        with self.store.db() as db:
            db.execute('BEGIN IMMEDIATE')
            for word,original,event in validated:
                row=db.execute('SELECT * FROM words WHERE word=?',(word,)).fetchone()
                if row:existing.append(row['id'])
                else:
                    cur=db.execute("INSERT INTO words (word,tag,created,updated,due,preparation_queue) VALUES (?,'Essay spelling',?,?,?,?)",(word,stamp,stamp,stamp,mode))
                    row=db.execute('SELECT * FROM words WHERE id=?',(cur.lastrowid,)).fetchone()
                    save_card(db,card_for(db,row));added.append(row['id'])
                # A genuine confirmed misspelling is evidence, never an invented quiz answer.
                if original['original'].casefold().replace('’',"'")!=word:
                    count=original['count']
                    cur=db.execute('INSERT OR IGNORE INTO essay_slips VALUES (?,?,?,?)',(event,row['id'],stamp,count))
                    if cur.rowcount:
                        db.execute("UPDATE words SET essay_mistakes=essay_mistakes+?,essay_mistake_at=?,drill_completed_at='' WHERE id=?",(count,stamp,row['id']))
                        marked.append(row['id'])
        return {'added':list(dict.fromkeys(added)),'existing':list(dict.fromkeys(existing)),'marked':list(dict.fromkeys(marked)),'mode':mode}
