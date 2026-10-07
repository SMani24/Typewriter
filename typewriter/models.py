"""Validate model IDs and discover available generation models without generating text."""
import hashlib
import json
import re
import time


class ModelAccessError(ValueError):
    """A key may be rejected while another key can still validate the model."""

    def __init__(self, message, rate_limited=False):
        super().__init__(message)
        self.rate_limited = rate_limited


def normalize_model(value):
    if not isinstance(value, str):
        raise ValueError("Enter a Gemini model ID.")
    value = value.strip().lower().removeprefix("models/")
    match = re.fullmatch(r"gemini-(flash(?:-lite)?|pro)-(\d+(?:\.\d+)?)(-[a-z0-9.-]+)?", value)
    if match:
        family, version, suffix = match.groups()
        value = f"gemini-{version}-{family}{suffix or ''}"
    if not re.fullmatch(r"gemini-[a-z0-9][a-z0-9.-]{0,79}", value):
        raise ValueError("Enter a model ID such as gemini-3.5-flash or gemini-flash-latest.")
    return value


class ModelCatalog:
    def __init__(self, store, network):
        self.store, self.network = store, network

    def validate(self, model, key):
        model = normalize_model(model)
        cache_key = "model:" + model + ":" + hashlib.sha256(key.encode()).hexdigest()[:20]
        with self.store.db() as db:
            cached = db.execute("SELECT value FROM cache WHERE name=?", (cache_key,)).fetchone()
        if cached and float(cached["value"]) > time.time() - 86400:
            return model
        response = self.network.request("GET", f"https://generativelanguage.googleapis.com/v1beta/models/{model}", headers={"x-goog-api-key": key}, timeout=(10, 20))
        self.store.log("info", f"Model validation returned HTTP {response.status_code}.")
        if response.status_code == 429:
            raise ModelAccessError("Model metadata is rate limited for this key.", rate_limited=True)
        if response.status_code in (401, 403) or response.status_code == 400 and "API_KEY_INVALID" in response.text:
            raise ModelAccessError("This key could not access model metadata. No generation request was sent.")
        if response.status_code in (400, 404):
            raise ValueError("This model ID is unavailable. Use Refresh model list in Settings and choose an available model. No generation request was sent.")
        if response.status_code != 200:
            raise ValueError("Could not validate the model with this key. Check API access or try Refresh model list in Settings. No generation request was sent.")
        try:
            supported = "generateContent" in response.json().get("supportedGenerationMethods", [])
        except (ValueError, TypeError, AttributeError):
            supported = False
        if not supported:
            raise ValueError("This model does not support text generation. Choose a model from the refreshed list.")
        with self.store.db() as db:
            db.execute("INSERT OR REPLACE INTO cache VALUES (?,?)", (cache_key, str(time.time())))
        return model

    def list(self, key):
        models, page = set(), None
        for _ in range(10):
            response = self.network.request("GET", "https://generativelanguage.googleapis.com/v1beta/models", headers={"x-goog-api-key": key}, params={"pageSize": 1000, **({"pageToken": page} if page else {})}, timeout=(10, 20))
            if response.status_code in (401, 403, 429):
                raise ModelAccessError("This key could not load model metadata.", rate_limited=response.status_code == 429)
            if response.status_code != 200:
                raise ValueError("Could not load the model list. Check your key, connection, and API access.")
            try:
                payload = response.json()
                for item in payload["models"]:
                    if "generateContent" in item.get("supportedGenerationMethods", []):
                        try:
                            models.add(normalize_model(item["name"]))
                        except (ValueError, KeyError):
                            continue
                page = payload.get("nextPageToken")
            except (ValueError, KeyError, TypeError, AttributeError):
                raise ValueError("The model list was incomplete. Try again later.") from None
            if not page:
                self.store.log("info", f"Loaded {len(models)} text generation model IDs.")
                return sorted(models)
        raise ValueError("The model list was too large. Try again later.")
