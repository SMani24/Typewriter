"""One explicit network route for dictionary, audio, and Gemini requests."""
from urllib.parse import quote
import requests


class NetworkError(RuntimeError):
    pass


class Network:
    def __init__(self, store):
        self.store = store

    def session(self):
        settings = self.store.settings(private=True)
        session = requests.Session()
        # Disabling the app proxy means direct networking, even if the shell has a proxy.
        session.trust_env = False
        if settings["proxy_enabled"]:
            host = settings["proxy_host"]
            if ":" in host and not host.startswith("["):
                host = f"[{host}]"
            auth = ""
            if settings["proxy_username"]:
                auth = quote(settings["proxy_username"], safe="") + ":" + quote(settings["proxy_password"], safe="") + "@"
            proxy = f"{settings['proxy_type']}://{auth}{host}:{settings['proxy_port']}"
            session.proxies = {"http": proxy, "https": proxy}
        return session

    def request(self, method, url, **kwargs):
        kwargs.setdefault("timeout", (10, 45))
        try:
            with self.session() as session:
                return session.request(method, url, **kwargs)
        except requests.RequestException:
            # Exception URLs/headers may include credentials. Never pass them to the UI/log.
            if self.store.settings()["proxy_enabled"]:
                raise NetworkError("Could not connect through the proxy. Check that it is running and that the protocol, host, and port are correct.") from None
            raise NetworkError("Could not connect. Check your internet connection or enable a proxy in Settings.") from None

    def test(self):
        response = self.request("GET", "https://generativelanguage.googleapis.com", timeout=(8, 12))
        # A 404 still proves that HTTPS reached the destination through the selected route.
        if response.status_code >= 500 or response.status_code == 407:
            raise NetworkError("The network route responded, but the upstream service or proxy is unavailable.")
        return {"ok": True, "message": "Connected through your proxy." if self.store.settings()["proxy_enabled"] else "Direct connection is working."}
