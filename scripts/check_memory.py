#!/usr/bin/env python3
"""Repeat a bounded synthetic workload; never read the user's notebook or keys."""
import argparse,gc,json,os,re,tempfile,time
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from typewriter.web import create_app


def rss_mib():
    return round(int(re.search(r'^VmRSS:\s+(\d+)',Path('/proc/self/status').read_text(),re.M)[1])/1024,2)


def peak_mib():
    return round(int(re.search(r'^VmHWM:\s+(\d+)',Path('/proc/self/status').read_text(),re.M)[1])/1024,2)


def run(cycles=80):
    os.environ['GEMINI_API_KEY']='';os.environ['GEMINI_API_KEYS']=''
    with tempfile.TemporaryDirectory(prefix='typewriter-memory-') as folder:
        app=create_app(folder,Path(folder)/'no-keys',background=False);store=app.extensions['store']
        store.save_settings({'preparation_method':'manual','auto_ai':False})
        store.add_words([{'word':'sample'+chr(97+i//26)+chr(97+i%26),'definition':'A useful example meaning.','sentence':'The sample'+chr(97+i//26)+chr(97+i%26)+' is a deliberately synthetic example.','tip':'Notice the letters.'} for i in range(200)])
        client=app.test_client();token=re.search(r'name="typewriter-token" content="([^"]+)"',client.get('/').text).group(1);headers={'X-Typewriter-Token':token}
        text=('A neccessary change has downsides. My CV describes the enviroment. '*1600)[:100000]
        samples=[];started=time.monotonic()
        for i in range(cycles+10):
            response=client.get('/api/state');assert response.status_code==200;response.close()
            for path in ('/api/essay/spelling','/api/essay/words'):
                response=client.post(path,json={'text':text},headers=headers);assert response.status_code==200;response.close()
            if i in (9,cycles//2+9,cycles+9):
                gc.collect();samples.append({'cycle':i-9,'rss_mib':rss_mib()})
        with store.db() as db:extractions=db.execute("SELECT COUNT(*) FROM cache WHERE name LIKE 'essay-words:%'").fetchone()[0]
        return {'words':200,'essay_characters':len(text),'measured_cycles':cycles,'requests_per_cycle':3,'warmup_cycles':10,'samples':samples,'growth_mib':round(samples[-1]['rss_mib']-samples[0]['rss_mib'],2),'peak_rss_mib':max(peak_mib(),max(sample['rss_mib'] for sample in samples)),'identical_essay_extractions_retained':extractions,'download_locks':len(app.extensions['dictionary']._download_locks),'alternative_locks':len(app.extensions['dictionary'].alternatives.locks),'elapsed_seconds':round(time.monotonic()-started,2)}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--cycles',type=int,default=80);args=parser.parse_args()
    if not 10<=args.cycles<=1000:parser.error('Choose 10–1000 cycles.')
    print(json.dumps(run(args.cycles),indent=2))
