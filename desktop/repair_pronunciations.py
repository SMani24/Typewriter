#!/usr/bin/env python3
"""Check saved words through the configured proxy and use available alternate accents."""
import argparse
import json
import sqlite3
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT))
from typewriter.store import Store
from typewriter.network import Network
from typewriter.dictionary import Dictionary


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir',type=Path,default=ROOT/'data')
    parser.add_argument('--apply',action='store_true',help='Back up the notebook, check words, and save available alternatives')
    args=parser.parse_args()
    if not args.apply:parser.error('Use --apply to perform the repair. A database backup is created first.')
    stamp=datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
    backups=args.data_dir/'backups';backups.mkdir(exist_ok=True,mode=0o700)
    backup=backups/f'before-pronunciation-repair-{stamp}.db'
    with sqlite3.connect(f'file:{args.data_dir / "typewriter.db"}?mode=ro',uri=True) as source, sqlite3.connect(backup) as destination:
        source.backup(destination)
    backup.chmod(0o600)
    store=Store(args.data_dir/'typewriter.db');dictionary=Dictionary(store,Network(store))
    words=store.list_words();results=[]
    def repair(word):
        try:return dictionary.pronunciation(word['id'],choose_alternative=True)
        except Exception as error:return {'id':word['id'],'word':word['word'],'error':str(error) if isinstance(error,ValueError) else 'Pronunciation check could not complete. Retry when the connection is available.'}
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures=[pool.submit(repair,w) for w in words]
        for future in as_completed(futures):
            results.append(future.result())
            print(f'Checked {len(results)}/{len(words)} words.',flush=True)
    report=args.data_dir/f'pronunciation-repair-{stamp}.json'
    report.write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n');report.chmod(0o600)
    summary={'checked':len(results),'alternative_selected':sum(bool(r.get('alternative') and r.get('selected')==r.get('alternative')) for r in results),'no_recording':sum(not r.get('error') and not r.get('uploaded') and not r.get('available') for r in results),'errors':sum('error' in r for r in results),'report':str(report),'backup':str(backup)}
    print(json.dumps(summary))
    return 1 if summary['errors'] else 0

if __name__=='__main__':sys.exit(main())
