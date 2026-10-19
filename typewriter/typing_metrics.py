"""Versioned optional aggregates, isolated from grading and both schedulers."""
import hashlib
import json
import re

VERSION=1
DAY=86400000
FLAGS={'reading_prompt','focus_loss','hidden','paste','drop','composition','replacement','history_edit','bulk_input','unclassified_input','untrusted_input','audio_replayed','audio_overlap','audio_incomplete','long_idle','presentation_pending'}
TIMES={'typing_span_ms','active_typing_ms','idle_gap_ms','excluded_ms'}
NULL_TIMES={'initial_latency_ms','max_pause_ms','audio_duration_ms'}
COUNTS={'input_events','revision_events','deleted_units','inserted_units','focus_loss_count','hidden_count','audio_plays'}
BASE={'version','latency_basis','pause_bins','flags'}|TIMES|NULL_TIMES|COUNTS
CONTEXT={'session_group','target_length','prompt_length','input_method','word_version'}
METHODS={'unknown','hardware','touch','other'}


def validate(value,imported=False):
    """Invalid experimental metadata is dropped; an answer is still graded normally."""
    fields=BASE|CONTEXT if imported else BASE
    if not isinstance(value,dict) or set(value)!=fields or type(value.get('version')) is not int or value['version']!=VERSION:return None
    integer=lambda n,limit:type(n) is int and 0<=n<=limit
    if any(not integer(value[k],DAY) for k in TIMES):return None
    if any(value[k] is not None and not integer(value[k],DAY) for k in NULL_TIMES):return None
    if any(not integer(value[k],20000 if k in ('deleted_units','inserted_units') else 10000) for k in COUNTS):return None
    if value['input_events']<1 or value['inserted_units']<1 or value['revision_events']>value['input_events'] or value['active_typing_ms']>value['typing_span_ms']:return None
    if value['latency_basis'] not in ('prompt-visible','audio-ended','unavailable') or (value['initial_latency_ms'] is None)!=(value['latency_basis']=='unavailable'):return None
    bins=value['pause_bins'];flags=value['flags']
    if not isinstance(bins,list) or len(bins)!=5 or any(not integer(n,10000) for n in bins) or sum(bins)>value['input_events']-1:return None
    if (value['max_pause_ms'] is None)!=(sum(bins)==0):return None
    if not isinstance(flags,list) or len(flags)>len(FLAGS) or any(not isinstance(flag,str) or flag not in FLAGS for flag in flags) or len(set(flags))!=len(flags):return None
    if imported:
        if not isinstance(value['session_group'],str) or not re.fullmatch('[a-f0-9]{32}',value['session_group']):return None
        if not integer(value['target_length'],80) or not value['target_length'] or not integer(value['prompt_length'],2100) or not integer(value['word_version'],1000000000) or not isinstance(value['input_method'],str) or value['input_method'] not in METHODS:return None
    return {**value,'flags':sorted(flags),'pause_bins':list(bins)}


def eligible(attempt):
    return attempt.get('mode')=='review' and not attempt.get('hinted') and attempt.get('exercise') in ('sentence','definition','audio') and attempt.get('session_kind') in ('normal','selected','endless')


def save(db,attempt_id,data,word,metadata,settings):
    if not settings.get('typing_metrics_enabled') or not eligible({**metadata,**data}):return
    session=db.execute('SELECT settings FROM practice_sessions WHERE id=?',(data.get('session_id'),)).fetchone()
    if not session:return
    session_settings=json.loads(session['settings'])
    if not session_settings.get('typing_metrics_enabled'):return
    summary=validate(data.get('typing'))
    if summary is None:return
    group=hashlib.sha256(data['session_id'].encode()).hexdigest()[:32]
    if db.execute('SELECT 1 FROM attempt_typing t JOIN attempts a ON a.id=t.attempt_id WHERE a.word_id=? AND json_extract(t.summary,\'$.session_group\')=?',(word['id'],group)).fetchone():return
    prompt=word['sentence'] if metadata['exercise']=='sentence' else word['definition'] if metadata['exercise']=='definition' else ''
    summary.update(session_group=group,target_length=len(word['word']),prompt_length=len(prompt),input_method=session_settings.get('typing_input_method','unknown'),word_version=word['version'])
    db.execute('INSERT INTO attempt_typing VALUES (?,?,?)',(attempt_id,VERSION,json.dumps(summary,separators=(',',':'))))
