"""Exact-word alternatives, with preview before consent and no automatic replacement."""
import hashlib
import json
import re
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Lock
from urllib.parse import quote, unquote, urljoin, urlparse, parse_qs

import requests
from bs4 import BeautifulSoup
from .audio_metadata import PROVIDERS, LABELS, allowed_url, canonical_url, candidate_id, validate_record, save_selected
from .network import NetworkError

AGENT='Typewriter/1.0 (personal spelling practice; https://github.com/SMani24/Typewriter)'


class AudioSources:
    def __init__(self, store, network):
        self.store,self.network=store,network
        self.locks={}

    def target(self, word_id):
        word=self.store.word(word_id)
        if not word:raise KeyError('Word not found.')
        return word

    @staticmethod
    def scope(word):
        return str(word['id'])+':'+hashlib.sha256((word['word']+'\0'+word['created']).encode()).hexdigest()[:16]

    def read(self, url, params=None, media_provider=None, limit=2*1024*1024):
        # Do not follow an upstream redirect to an arbitrary host, even on previews.
        for _ in range(4):
            if media_provider:
                url=allowed_url(url,media_provider)
            else:
                parsed=urlparse(url)
                if parsed.scheme!='https' or parsed.hostname not in ('www.oxfordlearnersdictionaries.com','en.wiktionary.org','commons.wikimedia.org','api.dictionaryapi.dev') or parsed.username or parsed.password or parsed.port not in (None,443):
                    raise ValueError('Unsupported pronunciation lookup source.')
            response=self.network.request('GET',url,params=params,stream=True,allow_redirects=False,timeout=(5,12),headers={'User-Agent':'Mozilla/5.0 (compatible; Typewriter personal dictionary lookup)' if urlparse(url).hostname=='www.oxfordlearnersdictionaries.com' else AGENT})
            try:
                if response.status_code in (301,302,303,307,308):
                    url=urljoin(url,response.headers.get('Location',''));params=None;continue
                if response.status_code==404:return None,url
                if response.status_code!=200:raise ValueError('This pronunciation source is unavailable right now.')
                chunks=[];size=0
                for chunk in response.iter_content(65536):
                    size+=len(chunk)
                    if size>limit:raise ValueError('The pronunciation response is too large.')
                    chunks.append(chunk)
                return b''.join(chunks),url
            except requests.RequestException:
                raise NetworkError('The pronunciation download was interrupted. Try the next voice or check your proxy.') from None
            finally:response.close()
        raise ValueError('This pronunciation source redirected too many times.')

    @staticmethod
    def record(word,provider,url,accent,source,author='',license_name='Publisher recording',license_url=''):
        url=canonical_url(url)
        return validate_record({'version':1,'id':candidate_id(url),'word':word,'provider':provider,'url':url,'accent':accent,'source_url':source,'author':author,'license_name':license_name,'license_url':license_url},word)

    @staticmethod
    def oxford(word,html,url):
        soup=BeautifulSoup(html,'html.parser');result=[]
        for heading in soup.select('h1.headword'):
            if heading.get_text(' ',strip=True).lower()!=word:continue
            container=heading.find_parent(class_='top-container')
            if not container:continue
            for node in container.select('.sound[data-src-mp3]'):
                accent='uk' if 'pron-uk' in node.get('class',[]) else 'us' if 'pron-us' in node.get('class',[]) else 'unknown'
                try:result.append(AudioSources.record(word,'oxford',urljoin(url,node['data-src-mp3']),accent,url,'Oxford University Press',license_url=url))
                except ValueError:continue
        return result

    @staticmethod
    def wiki_titles(word,html):
        soup=BeautifulSoup(html,'html.parser')
        title=soup.select_one('#firstHeading,.mw-page-title-main')
        if not title or title.get_text(' ',strip=True).lower()!=word:return []
        heading=soup.select_one('h2#English')
        if not heading:return []
        titles=[]
        pattern=r'(?<![a-z])'+re.escape(word).replace(r'\ ',r'[ _-]+')+r'(?![a-z])'
        for node in heading.find_all_next(['h2','audio']):
            if node.name=='h2':break
            name=node.get('data-mwtitle','')
            if node.find_parent(class_='audiotable') and re.search(pattern,name.lower()) and name.lower().endswith(('.mp3','.ogg','.wav')):
                titles.append('File:'+name)
        return list(dict.fromkeys(titles))[:8]

    def commons(self, titles=None, pageids=None):
        params={'action':'query','prop':'imageinfo','iiprop':'url|extmetadata','format':'json'}
        params['titles' if titles else 'pageids']='|'.join(titles or pageids)
        content,_=self.read('https://commons.wikimedia.org/w/api.php',params=params)
        if not content:return []
        pages=json.loads(content).get('query',{}).get('pages',{})
        result=[]
        for page in pages.values():
            for info in page.get('imageinfo',[]):
                metadata=info.get('extmetadata',{})
                text=lambda field:BeautifulSoup('<span>'+str(metadata.get(field,{}).get('value',''))+'</span>','html.parser').get_text(' ',strip=True)
                license_url=text('LicenseUrl').replace('http://','https://',1)
                result.append({'url':info.get('url'),'source_url':info.get('descriptionurl'),'author':text('Artist'),'license_name':text('LicenseShortName'),'license_url':license_url,'title':page.get('title','')})
        return result

    @staticmethod
    def accent(filename):
        name=unquote(filename).lower()
        if re.search(r'(?:^|[ _-])(?:uk|gb|rp)(?:[ _.-]|$)',name):return 'uk'
        if re.search(r'(?:^|[ _-])us(?:[ _.-]|$)',name):return 'us'
        if re.search(r'(?:^|[ _-])au(?:[ _.-]|$)',name):return 'au'
        return 'unknown'

    def wiki_records(self,word,metadata,provider):
        records=[]
        pattern=r'(?<![a-z])'+re.escape(word).replace(r'\ ',r'[ _-]+')+r'(?![a-z])'
        for info in metadata:
            # Checking the file's target as well as the entry prevents base-word substitutions.
            if not re.search(pattern,info['title'].lower()):continue
            try:records.append(self.record(word,provider,info['url'],self.accent(info['title']),info['source_url'],info['author'],info['license_name'],info['license_url']))
            except ValueError:continue
        return records

    def fetch(self,word,provider):
        target=word['word']
        if provider=='cambridge':
            source='https://dictionary.cambridge.org/dictionary/english/'+quote(target.replace(' ','-'))
            current=word['audio_urls'].get(word['pronunciation_accent'] or self.store.settings()['pronunciation_accent']) or word['audio_url']
            return [self.record(target,provider,url,accent,source,'Cambridge Dictionary',license_url=source) for accent,url in word['audio_urls'].items() if url!=current]
        if provider=='oxford':
            url='https://www.oxfordlearnersdictionaries.com/definition/english/'+quote(target.replace(' ','-'))
            content,final=self.read(url)
            return self.oxford(target,content,final) if content else []
        if provider=='wiktionary':
            content,_=self.read('https://en.wiktionary.org/wiki/'+quote(target.replace(' ','_')))
            titles=self.wiki_titles(target,content) if content else []
            return self.wiki_records(target,self.commons(titles=titles),provider) if titles else []
        content,_=self.read('https://api.dictionaryapi.dev/api/v2/entries/en/'+quote(target))
        payload=json.loads(content) if content else []
        ids=[]
        if isinstance(payload,list):
            for entry in payload[:10]:
                if not isinstance(entry,dict) or entry.get('word','').lower()!=target:continue
                for phonetic in entry.get('phonetics',[])[:10]:
                    source=phonetic.get('sourceUrl','')
                    parsed=urlparse(source)
                    identity=parse_qs(parsed.query).get('curid',[''])[0]
                    if phonetic.get('audio') and parsed.scheme=='https' and parsed.hostname=='commons.wikimedia.org' and identity.isdigit():ids.append(identity)
        ids=list(dict.fromkeys(ids))[:8]
        return self.wiki_records(target,self.commons(pageids=ids),provider) if ids else []

    def options(self,word_id,provider,reset=False):
        if provider not in PROVIDERS or not isinstance(reset,bool):raise ValueError('Choose a supported pronunciation source.')
        word=self.target(word_id);scope=self.scope(word)
        cache='audio-options:'+scope+':'+provider
        rejected_key='rejected-audio:'+scope
        with self.store.db() as db:
            if reset:db.execute('DELETE FROM cache WHERE name=?',(rejected_key,))
            saved=db.execute('SELECT value FROM cache WHERE name=?',(cache,)).fetchone()
        records=None
        if saved:
            saved=json.loads(saved['value'])
            ttl=timedelta(days=7) if saved['records'] else timedelta(hours=1)
            if datetime.now(timezone.utc)-datetime.fromisoformat(saved['created'])<ttl:records=saved['records']
        if records is None:
            try:records=self.fetch(word,provider)
            except (ValueError,NetworkError,KeyError,TypeError,AttributeError):
                self.store.log('warning',LABELS[provider]+' pronunciation lookup unavailable. Other sources remain available.')
                return {'candidates':[],'provider':provider,'unavailable':True}
            with self.store.db() as db:db.execute('INSERT OR REPLACE INTO cache VALUES (?,?)',(cache,json.dumps({'created':datetime.now(timezone.utc).isoformat(),'records':records})))
        preferred=word['pronunciation_accent'] or self.store.settings()['pronunciation_accent']
        with self.store.db() as db:
            row=db.execute('SELECT value FROM cache WHERE name=?',(rejected_key,)).fetchone()
            rejected=json.loads(row['value']) if row else []
            result=[]
            for record in records:
                if record['id'] in rejected or record['id']==word['audio_alternative'].get('id'):continue
                key='audio-candidate:'+scope+':'+record['id']
                db.execute('INSERT OR REPLACE INTO cache VALUES (?,?)',(key,json.dumps(record)))
                result.append(record)
        return {'candidates':sorted(result,key=lambda r:(r['accent']!=preferred,r['id'])),'provider':provider,'unavailable':False}

    def candidate(self,word_id,identity):
        word=self.target(word_id)
        if not isinstance(identity,str) or not re.fullmatch('[a-f0-9]{32}',identity):raise ValueError('Choose an offered pronunciation.')
        with self.store.db() as db:
            row=db.execute('SELECT value FROM cache WHERE name=?',('audio-candidate:'+self.scope(word)+':'+identity,)).fetchone()
        if not row:raise ValueError('This pronunciation offer is outdated. Search again for the current spelling.')
        return word,validate_record(json.loads(row['value']),word['word'])

    def path(self,record):
        return self.store.path.parent/'audio'/('alternative-'+record['id']+Path(urlparse(record['url']).path).suffix.lower())

    def recording(self,record):
        path=self.path(record)
        with self.locks.setdefault(record['id'],Lock()):
            if not path.is_file():
                content,_=self.read(record['url'],media_provider=record['provider'],limit=5*1024*1024)
                extension=path.suffix
                valid=content and (extension=='.mp3' and (content.startswith(b'ID3') or len(content)>2 and content[0]==255 and content[1]&224==224) or extension=='.ogg' and content.startswith(b'OggS') or extension=='.wav' and content[:4]==b'RIFF' and content[8:12]==b'WAVE')
                if not valid:raise ValueError('This source did not return a playable audio recording. Try the next voice.')
                path.parent.mkdir(exist_ok=True)
                with tempfile.NamedTemporaryFile(dir=path.parent,delete=False) as temporary:temporary.write(content);temp=Path(temporary.name)
                try:temp.replace(path);path.chmod(0o600)
                finally:temp.unlink(missing_ok=True)
        return path

    def preview(self,word_id,identity):
        _,record=self.candidate(word_id,identity)
        return self.recording(record)

    def reject(self,word_id,identity):
        word,_=self.candidate(word_id,identity);key='rejected-audio:'+self.scope(word)
        with self.store.db() as db:
            row=db.execute('SELECT value FROM cache WHERE name=?',(key,)).fetchone()
            rejected=json.loads(row['value']) if row else []
            db.execute('INSERT OR REPLACE INTO cache VALUES (?,?)',(key,json.dumps(list(dict.fromkeys([*rejected,identity])))))
        return {'rejected':True}

    def accept(self,word_id,identity):
        word,record=self.candidate(word_id,identity)
        if not self.path(record).is_file():raise ValueError('Preview this recording before choosing it.')
        with self.store.db() as db:
            db.execute('BEGIN IMMEDIATE')
            current=db.execute('SELECT * FROM words WHERE id=?',(word_id,)).fetchone()
            if not current or current['word']!=word['word'] or current['created']!=word['created']:raise ValueError('The word changed. Search again before choosing a voice.')
            if current['audio_file']:raise ValueError('Remove your uploaded recording before choosing another source.')
            row=db.execute('SELECT value FROM cache WHERE name=?',('rejected-audio:'+self.scope(word),)).fetchone()
            if row and identity in json.loads(row['value']):raise ValueError('This voice was rejected. Search again including rejected voices to reconsider it.')
            record={**record,'approved_at':datetime.now(timezone.utc).isoformat()}
            save_selected(db,current,record)
            db.execute('UPDATE words SET audio_verified=1,audio_flagged=0 WHERE id=?',(word_id,))
        return self.store.word(word_id)

    def clear(self,word_id):
        self.target(word_id)
        with self.store.db() as db:
            db.execute('DELETE FROM cache WHERE name=?',('chosen-audio:'+str(word_id),))
            db.execute('UPDATE words SET audio_verified=0 WHERE id=?',(word_id,))
        return self.store.word(word_id)
