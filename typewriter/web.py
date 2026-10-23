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
from .spelling import check as check_spelling
from .essay_words import EssayWords
from .essay_intake import EssayIntake
from .voice_preparation import VoicePreparation
from .audio_processing import AudioProcessing
from .diagnostics import Diagnostics
from .ankiautomata import AnkiAutomata, AnkiAutomataError

ROOT = Path(__file__).resolve().parent.parent


def create_app(data_dir=None, keys_path=None, background=True,diagnostics=None):
    app = Flask(__name__, template_folder=str(ROOT / "templates"), static_folder=str(ROOT / "static"))
    app.config.update(MAX_CONTENT_LENGTH=32 * 1024 * 1024, TRUSTED_HOSTS=["127.0.0.1", "localhost", "[::1]"])
    directory = Path(data_dir or os.environ.get("TYPEWRITER_DATA_DIR", ROOT / "data"))
    store = Store(directory / "typewriter.db")
    directory.chmod(0o700)
    store.path.chmod(0o600)
    keys = Path(keys_path or ROOT / "api_keys.txt")
    network = Network(store)
    dictionary = Dictionary(store, network)
    audio_processing=AudioProcessing(store)
    diagnostics=diagnostics or Diagnostics(directory)
    enrichment = Enrichment(store, network, keys)
    voice_preparation=VoicePreparation(store,dictionary)
    if background:enrichment.after_prepare=voice_preparation.start
    preparation = Preparation(store)
    essay_words = EssayWords(store)
    intake = EssayIntake(store)
    ankiautomata = AnkiAutomata()
    token = secrets.token_urlsafe(32)
    app.extensions.update(store=store, network=network, dictionary=dictionary, enrichment=enrichment, preparation=preparation, voice_preparation=voice_preparation,audio_processing=audio_processing,ankiautomata=ankiautomata)

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
        cached_audio = request.method in ("GET", "HEAD") and request.path.endswith("/audio") and request.args.get("v") and response.status_code in (200, 206, 304)
        if cached_audio:
            response.cache_control.private = True
            response.cache_control.public = False
        elif request.path.startswith("/api") or request.path == "/":
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
        identity=diagnostics.exception(error)
        try:store.log("error", f"An unexpected application error occurred. Reference: {identity or 'unavailable'}. Saved words are safe.")
        except Exception:pass
        return jsonify(error="Something went wrong. Your saved words are safe. Please try again.",reference=identity), 500

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
        return jsonify(words=store.list_words(), progress=store.progress(), settings=store.settings(), enrichment=enrichment.snapshot(), logs=store.logs(),voice_preparation=voice_preparation.snapshot(),audio_processing=audio_processing.snapshot(),audio_pause_until=store.audio_pause_until())

    @app.post('/api/practice/audio-pause')
    def pause_audio():
        return jsonify(until=store.pause_audio(body().get('resume',False)))

    @app.get("/api/essay")
    def essay():
        return jsonify(store.essay())

    @app.put("/api/essay")
    def save_essay():
        return jsonify(store.save_essay(body()))

    @app.post("/api/essay/spelling")
    def essay_spelling():
        return jsonify(check_spelling(body().get("text"),store.personal_dictionary()))

    @app.get("/api/essay/dictionary")
    def personal_dictionary():
        return jsonify(words=store.personal_dictionary())

    @app.route("/api/essay/dictionary",methods=["POST","DELETE"])
    def edit_personal_dictionary():
        return jsonify(store.set_personal_word(body().get("word"),request.method=="DELETE"))

    @app.post("/api/essay/words")
    def extract_essay_words():
        return jsonify(essay_words.extract(body().get("text")))

    @app.post("/api/essay/words/intake")
    def queue_essay_words():
        result=intake.add(body())
        if background:enrichment.auto_schedule()
        return jsonify(result)

    @app.post("/api/words/<int:word_id>/activate")
    def activate_word(word_id):
        return jsonify(store.activate_word(word_id))

    @app.post("/api/essay/words/prompts")
    def export_essay_word_prompts():
        output,name=essay_words.export(body())
        return send_file(output,mimetype="application/zip",as_attachment=True,download_name=name)

    @app.post("/api/essay/words/preview")
    def preview_essay_word_reply():
        return jsonify(essay_words.preview(body().get("text")))

    @app.get("/api/logs/export")
    def export_logs():
        lines = [f"{r['created']} [{r['level']}] {r['message']}" for r in reversed(store.logs(500))]
        return Response("\n".join(lines) + "\n\nFailure locations (no messages or notebook contents):\n"+diagnostics.export(), mimetype="text/plain", headers={"Content-Disposition": 'attachment; filename="typewriter-log.txt"'})

    @app.post('/api/diagnostics')
    def record_diagnostic():
        identity=diagnostics.browser(body())
        if identity:store.log('error',f'A browser failure was recorded. Reference: {identity}. Download the application log for its script location.')
        return jsonify(reference=identity),202

    @app.get("/api/health")
    def health():
        return jsonify(app="typewriter", instance=hashlib.sha256(str(store.path.resolve()).encode()).hexdigest())

    @app.post("/api/words")
    def add_words():
        result = store.add_words(body().get("words"))
        if background:
            enrichment.auto_schedule()
        return jsonify(result), 201

    @app.post("/api/integrations/ankiautomata/lookup")
    def open_in_ankiautomata():
        data = body()
        if "word_id" in data:
            if type(data["word_id"]) is not int or data["word_id"] <= 0 or "word" in data or "sentence" in data:
                raise ValueError("Choose a saved word or send draft fields, not both.")
            item = store.word(data["word_id"])
            if not item:
                raise KeyError("Word not found.")
        else:
            item = store.validate_word({"word": data.get("word"), "sentence": data.get("sentence", "")})
        try:
            return jsonify(ankiautomata.lookup(item["word"], item["sentence"]))
        except AnkiAutomataError as error:
            return jsonify(error=str(error)), error.status

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

    @app.patch("/api/words/<int:word_id>/sentence")
    def sentence_settings(word_id):
        return jsonify(store.set_sentence_flag(word_id,body().get("flagged")))

    @app.post("/api/words/<int:word_id>/attempts")
    def attempt(word_id):
        return jsonify(store.attempt(word_id, body()))

    @app.post("/api/words/<int:word_id>/drill-completion")
    def complete_drill(word_id):
        return jsonify(store.complete_drill(word_id, body()))

    @app.get("/api/words/<int:word_id>/audio")
    def audio(word_id):
        return send_file(audio_processing.normalize(dictionary.audio(word_id, preview=request.args.get("preview") == "1", accent=request.args.get("accent"))), max_age=86400 if request.args.get("v") else 0)

    @app.patch("/api/words/<int:word_id>/audio")
    def audio_settings(word_id):
        data = body()
        return jsonify(store.set_audio(word_id, flagged=data.get("flagged"), verified=data.get("verified")))

    @app.post("/api/words/<int:word_id>/pronunciation/check")
    def check_pronunciation(word_id):
        return jsonify(dictionary.pronunciation(word_id))

    @app.patch("/api/words/<int:word_id>/pronunciation")
    def pronunciation_choice(word_id):
        return jsonify(store.set_pronunciation(word_id,body().get("accent")))

    @app.post("/api/words/<int:word_id>/pronunciation/alternatives")
    def pronunciation_alternatives(word_id):
        data=body()
        return jsonify(dictionary.alternatives.options(word_id,data.get("provider"),data.get("reset",False)))

    @app.get("/api/words/<int:word_id>/pronunciation/alternatives/<identity>/audio")
    def preview_alternative(word_id,identity):
        return send_file(audio_processing.normalize(dictionary.alternatives.preview(word_id,identity)),max_age=0)

    @app.post("/api/words/<int:word_id>/pronunciation/alternatives/<identity>/reject")
    def reject_alternative(word_id,identity):
        return jsonify(dictionary.alternatives.reject(word_id,identity))

    @app.post("/api/words/<int:word_id>/pronunciation/alternatives/<identity>/accept")
    def accept_alternative(word_id,identity):
        return jsonify(dictionary.alternatives.accept(word_id,identity))

    @app.delete("/api/words/<int:word_id>/pronunciation/alternative")
    def clear_alternative(word_id):
        return jsonify(dictionary.alternatives.clear(word_id))

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

    @app.delete('/api/typing-metrics')
    def delete_typing_metrics():
        return jsonify(store.delete_typing_metrics())

    @app.post("/api/practice-sessions")
    def start_session():
        return jsonify(store.start_session(body()))

    @app.post("/api/practice-sessions/<session_id>/next")
    def next_word(session_id):
        return jsonify(store.session_next(session_id,body().get("position")))

    @app.post("/api/practice-sessions/<session_id>/heartbeat")
    def session_heartbeat(session_id):
        return jsonify(store.session_touch(session_id))

    @app.post("/api/practice-sessions/<session_id>/end")
    def end_session(session_id):
        return jsonify(store.session_touch(session_id,end=True))

    @app.post("/api/scheduler/preview")
    def scheduler_preview():
        return jsonify(store.scheduler_preview(body().get("target")))

    @app.post("/api/scheduler/switch")
    def scheduler_switch():
        return jsonify(store.scheduler_switch(body()))

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
        return jsonify(**enrichment.snapshot(),audio_pause_until=store.audio_pause_until())

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
        result=preparation.apply(body().get("text"))
        if background:voice_preparation.start()
        return jsonify(result)

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
        voice_preparation.start()
    return app
