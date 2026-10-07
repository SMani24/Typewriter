# Typewriter

A personal spelling notebook with focused typing drills and spaced reviews.
Runs locally in your browser; your words and progress live in SQLite on your computer.

## Run

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Open **http://127.0.0.1:8080**. Use `python app.py --port 8081` to change the port.

The app is being built in small steps. Word storage and review scheduling come first,
followed by dictionary lookup, batched Gemini assistance, and the practice interface.
API keys, proxy credentials, and personal data are excluded from Git.
