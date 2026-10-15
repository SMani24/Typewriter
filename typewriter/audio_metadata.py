"""Strict provenance and notebook bindings for user-approved pronunciation choices."""
import hashlib
import json
from datetime import datetime
from urllib.parse import urlparse, urlunparse

PROVIDERS = ('cambridge','oxford','wiktionary','free_dictionary')
LABELS = {'cambridge':'Cambridge Dictionary','oxford':"Oxford Learner’s Dictionaries",'wiktionary':'Wiktionary · Wikimedia Commons','free_dictionary':'Free Dictionary API · Wikimedia Commons'}


def canonical_url(value):
    if not isinstance(value,str) or len(value)>2000 or any(c.isspace() for c in value):
        raise ValueError('Invalid pronunciation URL.')
    parsed=urlparse('https:'+value if value.startswith('//') else value)
    if parsed.scheme!='https' or parsed.username or parsed.password or parsed.port not in (None,443) or not parsed.hostname:
        raise ValueError('Use a supported HTTPS pronunciation source.')
    return urlunparse(parsed._replace(query='',fragment=''))


def allowed_url(value, provider, kind='media'):
    value=canonical_url(value);parsed=urlparse(value);host=parsed.hostname;path=parsed.path
    if kind=='media':
        allowed=(provider=='cambridge' and host=='dictionary.cambridge.org' or
                 provider=='oxford' and host=='www.oxfordlearnersdictionaries.com' and path.startswith('/media/english/') or
                 provider in ('wiktionary','free_dictionary') and host=='upload.wikimedia.org' and path.startswith('/wikipedia/commons/'))
        if not allowed or not path.lower().endswith(('.mp3','.ogg','.wav')):
            raise ValueError('Unsupported pronunciation recording source.')
    else:
        allowed=(provider=='cambridge' and host=='dictionary.cambridge.org' and path.startswith('/dictionary/english/') or
                 provider=='oxford' and host=='www.oxfordlearnersdictionaries.com' and path.startswith('/definition/english/') or
                 provider in ('wiktionary','free_dictionary') and host=='commons.wikimedia.org' and path.startswith('/wiki/File:'))
        if not allowed:raise ValueError('Unsupported pronunciation reference page.')
    return value


def candidate_id(url):
    return hashlib.sha256(canonical_url(url).encode()).hexdigest()[:32]


def validate_record(data, word):
    if not isinstance(data,dict) or data.get('version')!=1 or data.get('provider') not in PROVIDERS or data.get('word')!=word:
        raise ValueError('Unsupported alternative pronunciation metadata.')
    provider=data['provider'];url=allowed_url(data.get('url'),provider)
    if data.get('id')!=candidate_id(url) or data.get('accent') not in ('uk','us','au','other','unknown'):
        raise ValueError('Invalid alternative pronunciation identity.')
    source=allowed_url(data.get('source_url'),provider,'source')
    result={k:data[k] for k in ('version','id','word','provider','accent')}
    result.update(url=url,source_url=source,label=LABELS[provider])
    for field,limit in (('author',500),('license_name',120)):
        value=data.get(field,'')
        if not isinstance(value,str) or len(value)>limit:raise ValueError('Invalid recording attribution.')
        result[field]=value
    license_url=data.get('license_url','')
    if provider in ('wiktionary','free_dictionary'):
        license_url=canonical_url(license_url)
        if urlparse(license_url).hostname!='creativecommons.org' or not urlparse(license_url).path.startswith(('/licenses/','/publicdomain/')):
            raise ValueError('Missing supported recording license.')
        if not result['author'] or not result['license_name']:raise ValueError('Missing recording attribution.')
    elif license_url:
        license_url=allowed_url(license_url,provider,'source')
    result['license_url']=license_url
    if 'approved_at' in data:
        try:
            if datetime.fromisoformat(data['approved_at']).tzinfo is None:raise ValueError()
        except (ValueError,TypeError):raise ValueError('Invalid pronunciation approval date.') from None
        result['approved_at']=data['approved_at']
    return result


def selected_audio(db, word):
    row=db.execute('SELECT value FROM cache WHERE name=?',('chosen-audio:'+str(word['id']),)).fetchone()
    if row:
        value=json.loads(row['value'])
        if value['word']==word['word'] and value['created']==word['created']:
            return value['record']
    return {}


def save_selected(db, word, record):
    db.execute('INSERT OR REPLACE INTO cache VALUES (?,?)',('chosen-audio:'+str(word['id']),json.dumps({'word':word['word'],'created':word['created'],'record':record})))
