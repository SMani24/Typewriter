"""Run the local Typewriter app."""
import argparse
from typewriter.web import create_app

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Typewriter — personal spelling practice")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    print(f"Typewriter is ready at http://127.0.0.1:{args.port}")
    create_app().run(host="127.0.0.1", port=args.port, debug=False, threaded=True)
