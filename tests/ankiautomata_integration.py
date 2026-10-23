"""Optional contract check against sibling source, without starting either real GUI.

Run with Typewriter's environment:
  .venv/bin/python tests/ankiautomata_integration.py --ankiautomata-root ../AnkiAutomata
"""
import argparse
import importlib.util
from pathlib import Path
from queue import Queue
import sys
import tempfile
from threading import Thread

import requests

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ankiautomata-root", type=Path, required=True)
    args = parser.parse_args()
    source = args.ankiautomata_root.resolve() / "ipc.py"
    spec = importlib.util.spec_from_file_location("ankiautomata_test_ipc", source)
    ipc = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ipc)
    from typewriter.web import create_app
    import re

    queue = Queue(maxsize=2)
    peer = ipc.LookupServer(queue, address=("127.0.0.1", 0))
    thread = Thread(target=peer.serve_forever, kwargs={"poll_interval": .01}, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            app = create_app(path / "notebook", path / "no-keys", background=False)
            app.extensions["ankiautomata"].address = f"http://127.0.0.1:{peer.server_port}"
            store, client = app.extensions["store"], app.test_client()
            token = re.search(r'name="typewriter-token" content="([^"]+)"', client.get("/").text).group(1)
            headers = {"X-Typewriter-Token": token}
            sentence = 'It is necessary: café, “quotes”, $(echo data).\nNo shell is involved.'
            identity = store.add_words([{"word": "necessary", "sentence": sentence}])["added"][0]
            before = store.word(identity)
            route = "/api/integrations/ankiautomata/lookup"
            result = client.post(route, json={"word_id": identity}, headers=headers)
            assert result.status_code == 200, result.json
            assert queue.get_nowait() == {"text": "necessary", "sentence": " ".join(sentence.split())}
            assert store.word(identity) == before
            assert client.post(route, json={"word": "necessary", "sentence": ""}, headers=headers).status_code == 200
            assert queue.get_nowait() == {"text": "necessary", "sentence": ""}
            # Omission is a distinct peer contract: preserve prior GUI context.
            # Typewriter intentionally always sends sentence, including blank.
            with requests.Session() as session:
                session.trust_env = False
                response = session.post(f"http://127.0.0.1:{peer.server_port}/lookup", json={"text": "necessary"}, timeout=(2, 4), allow_redirects=False)
                assert response.status_code == 200
            assert queue.get_nowait() == "necessary"
            queue.put_nowait("queued first")
            queue.put_nowait("queued second")
            response = client.post(route, json={"word_id": identity}, headers=headers)
            assert response.status_code == 429 and "queue is full" in response.json["error"]
            assert store.word(identity) == before
            print("AnkiAutomata integration passed: actual health/queue contract, sentence normalization, explicit clearing versus omission, full queue, and unchanged Typewriter word. No GUI or Anki collection was opened.")
    finally:
        peer.shutdown()
        peer.server_close()
        thread.join(timeout=2)


if __name__ == "__main__":
    main()
