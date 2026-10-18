"""Run the local Typewriter app."""
import argparse
import os
import logging
from pathlib import Path
from typewriter.web import create_app
from typewriter.diagnostics import Diagnostics

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Typewriter — personal spelling practice")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    diagnostics=Diagnostics(Path(os.environ.get('TYPEWRITER_DATA_DIR',Path(__file__).resolve().parent/'data')))
    diagnostics.install_hooks()
    logging.getLogger('werkzeug').setLevel(logging.WARNING)
    print(f"Typewriter is ready at http://127.0.0.1:{args.port}")
    create_app(diagnostics=diagnostics).run(host="127.0.0.1", port=args.port, debug=False, threaded=True)
