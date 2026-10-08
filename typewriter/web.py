"""Local HTTP interface. Secrets stay on the server, never in the browser bundle."""
import json
import hashlib
import os
import secrets
from pathlib import Path
from flask import Flask, jsonify, render_template, request, send_file, Response
from werkzeug.exceptions import HTTPException
from .store import Store
from .network import Network, NetworkError
from .dictionary import Dictionary
from .enrichment import Enrichment, parse_keys
from .preparation import Preparation
from .models import ModelAccessError

ROOT = Path(__file__).resolve().parent.parent


def create_app(data_dir=None, keys_path=None, background=True):
    app = Flask(__name__, template_folder=str(ROOT / "templates"), static_folder=str(ROOT / "static"))
    app.config.update(MAX_CONTENT_LENGTH=32 * 1024 * 1024, TRUSTED_HOSTS=["127.0.0.1", "localhost", "[::1]"])
    directory = Path(data_dir or os.environ.get("TYPEWRITER_DATA_DIR", ROOT / "data"))
    store = Store(directory / "typewriter.db")
    directory.chmod(0o700)
    store.path.chmod(0o600)
    keys = Path(keys_path or ROOT / "api_keys.txt")
    network = Network(store)
    dictionary = Dictionary(store, network)
    enrichment = Enrichment(store, network, keys)
    preparation = Preparation(store)
    token = secrets.token_urlsafe(32)
    app.extensions.update(store=store, network=network, dictionary=dictionary, enrichment=enrichment, preparation=preparation)

    @app.before_request
    def protect_local_app():
        origin = request.headers.get("Origin")
        if origin and origin.rstrip("/") != request.host_url.rstrip("/"):
            return jsonify(error="This app only accepts requests from its own page."), 403
        if request.headers.get("Sec-Fetch-Site") == "cross-site":
            return jsonify(error="Open Typewriter directly in your browser."), 403
        if request.method not in ["GET", "HEAD", "OPTIONS"] and not secrets.compare_digest(request.headers.get("X-Typewriter-Token", ""), token):
            return jsonify(error="Refresh the page before trying again."), 403

    @app.after_request
    def headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
        if request.path.startswith("/api") or request.path == "/":
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.errorhandler(Exception)
    def error(error):
        if isinstance(error, KeyError):
            return jsonify(error=error.args[0]), 404
        if isinstance(error, (ValueError, NetworkError)):
            return jsonify(error=str(error)), 400
        if isinstance(error, HTTPException):
            return jsonify(error=error.description), error.code
        # Network exceptions may carry API keys, URLs or proxy credentials.
        store.log("error", "An unexpected application error occurred. Saved words are safe.")
        return jsonify(error="Something went wrong. Your saved words are safe. Please try again."), 500

    def body():
        result = request.get_json()
        if not isinstance(result, dict):
            raise ValueError("Send a JSON object.")
        return result

    @app.get("/")
    def home():
        return render_template("index.html", token=token)

    @app.get("/api/state")
    def state():
        return jsonify(words=store.list_words(), progress=store.progress(), settings=store.settings(), enrichment=enrichment.snapshot(), logs=store.logs())

    @app.get("/api/logs/export")
    def export_logs():
        lines = [f"{r['created']} [{r['level']}] {r['message']}" for r in reversed(store.logs(500))]
        return Response("\n".join(lines) + "\n", mimetype="text/plain", headers={"Content-Disposition": 'attachment; filename="typewriter-log.txt"'})

    @app.get("/api/health")
    def health():
        return jsonify(app="typewriter", instance=hashlib.sha256(str(store.path.resolve()).encode()).hexdigest())

    @app.post("/api/words")
    def add_words():
        result = store.add_words(body().get("words"))
        if background:
            enrichment.auto_schedule()
        return jsonify(result), 201

    @app.patch("/api/words/<int:word_id>")
    def edit_word(word_id):
        return jsonify(store.edit_word(word_id, body()))

    @app.delete("/api/words/<int:word_id>")
    def delete_word(word_id):
        store.delete_word(word_id)
        return jsonify(ok=True)

    @app.patch("/api/words/<int:word_id>/meaning")
    def meaning_settings(word_id):
        return jsonify(store.set_meaning_flag(word_id, body().get("flagged")))

    @app.post("/api/words/<int:word_id>/attempts")
    def attempt(word_id):
        return jsonify(store.attempt(word_id, body()))

    @app.get("/api/words/<int:word_id>/audio")
    def audio(word_id):
        return send_file(dictionary.audio(word_id, preview=request.args.get("preview") == "1", accent=request.args.get("accent")), max_age=0)

    @app.patch("/api/words/<int:word_id>/audio")
    def audio_settings(word_id):
        data = body()
        return jsonify(store.set_audio(word_id, flagged=data.get("flagged"), verified=data.get("verified")))

    @app.post("/api/words/<int:word_id>/audio")
    def upload_audio(word_id):
        file = request.files.get("audio")
        if not file:
            raise ValueError("Choose an audio recording to upload.")
        return jsonify(dictionary.upload(word_id, file))

    @app.delete("/api/words/<int:word_id>/audio")
    def remove_uploaded_audio(word_id):
        word = store.word(word_id)
        if not word:
            raise KeyError("Word not found.")
        result = store.set_audio(word_id, file="", verified=False)
        if word["audio_file"]:
            (directory / "audio" / word["audio_file"]).unlink(missing_ok=True)
        return jsonify(result)

    @app.post("/api/dictionary")
    def lookup():
        return jsonify(dictionary.lookup(body().get("word", "")))

    @app.put("/api/settings")
    def settings():
        result = store.save_settings(body())
        if background:
            enrichment.auto_schedule()
        return jsonify(result)

    @app.put("/api/keys")
    def save_keys():
        raw = body().get("keys", "")
        if not isinstance(raw, str) or len(raw) > 100000:
            raise ValueError("Enter API keys as text, one per line.")
        values = parse_keys(raw)
        if not values:
            raise ValueError("No API keys found. Enter one key per line.")
        if os.environ.get("GEMINI_API_KEYS") or os.environ.get("GEMINI_API_KEY"):
            raise ValueError("Keys are supplied by an environment variable. Update that variable and restart the app.")
        # Write atomically with owner-only permissions; never echo the supplied values.
        temp = keys.with_suffix(".tmp")
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as file:
            file.write("\n".join(values) + "\n")
        temp.replace(keys)
        keys.chmod(0o600)
        if background:
            enrichment.auto_schedule()
        return jsonify(count=len(values))

    @app.post("/api/network/test")
    def test_network():
        return jsonify(network.test())

    @app.post("/api/enrichment/run")
    def run():
        return jsonify(enrichment.start(body().get("ids")))

    @app.get("/api/enrichment")
    def job():
        return jsonify(enrichment.snapshot())

    @app.post("/api/models/refresh")
    def models():
        available = enrichment.pool.keys()
        if not available:
            raise ValueError("Add a Gemini key first. Model discovery uses the configured network route.")
        for key in available:
            try:
                return jsonify(models=enrichment.catalog.list(key))
            except ModelAccessError:
                continue
        raise ValueError("None of the configured keys could load model metadata. Check API access or use prompt export/import.")

    @app.post("/api/preparation/export")
    def export_preparation():
        data = body()
        stream, name = preparation.export(data.get("ids"), data.get("size"), data.get("re_evaluate", False))
        return send_file(stream, mimetype="application/zip", as_attachment=True, download_name=name)

    @app.post("/api/preparation/preview")
    def preview_preparation():
        return jsonify(preparation.preview(body().get("text")))

    @app.post("/api/preparation/import")
    def import_preparation():
        return jsonify(preparation.apply(body().get("text")))

    @app.get("/api/export")
    def export():
        response = jsonify(store.export())
        response.headers["Content-Disposition"] = 'attachment; filename="typewriter-backup.json"'
        return response

    @app.post("/api/import")
    def import_backup():
        return jsonify(store.import_backup(body()))

    if background:
        enrichment.auto_schedule()
    return app
