#!/usr/bin/env python3
"""Start or reopen the local app without a terminal or a second server."""
import argparse
import fcntl
import hashlib
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def data_directory():
    return Path(os.environ.get("TYPEWRITER_DATA_DIR", ROOT / "data")).resolve()


def instance_id(directory):
    return hashlib.sha256(str(directory / "typewriter.db").encode()).hexdigest()


def is_running(port, directory):
    # Local readiness checks must never go through the desktop's proxy environment.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(f"http://127.0.0.1:{port}/api/health", timeout=1) as response:
            data = json.load(response)
        return data.get("app") == "typewriter" and data.get("instance") == instance_id(directory)
    except (OSError, ValueError, urllib.error.URLError):
        return False


def available_port(preferred):
    for port in range(preferred, min(preferred + 20, 65536)):
        try:
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", port))
                return port
        except OSError:
            continue
    raise RuntimeError("No free local port found. Close an unused local server and try again.")


def launch(preferred=8080):
    directory = data_directory()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    state_path = directory / "launcher.json"
    with (directory / "launcher.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            state = json.loads(state_path.read_text())
        except (OSError, ValueError):
            state = {}
        candidates = [state.get("port"), preferred]
        for port in candidates:
            if isinstance(port, int) and 1 <= port <= 65535 and is_running(port, directory):
                return f"http://127.0.0.1:{port}"
        python = ROOT / ".venv" / "bin" / "python"
        if not python.exists():
            raise RuntimeError("Typewriter's Python environment is missing. Follow the setup steps in README.md first.")
        port = available_port(preferred)
        log_path = directory / "launcher.log"
        # A short local startup log is useful if dependencies are missing. It contains
        # no request bodies, keys or connection settings, and is ignored by Git.
        with log_path.open("w") as log:
            log_path.chmod(0o600)
            child = subprocess.Popen([str(python), "-u", str(ROOT / "app.py"), "--port", str(port)], cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        for _ in range(150):
            if is_running(port, directory):
                temporary = state_path.with_suffix(".tmp")
                temporary.write_text(json.dumps({"port": port, "pid": child.pid}))
                temporary.replace(state_path)
                return f"http://127.0.0.1:{port}"
            if child.poll() is not None:
                break
            time.sleep(0.1)
        if child.poll() is None:
            child.terminate()
        raise RuntimeError(f"Typewriter could not start. See {log_path} for details.")


def stop():
    directory = data_directory()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / "launcher.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            state = json.loads((directory / "launcher.json").read_text())
            pid, port = state["pid"], state["port"]
            if not isinstance(pid, int) or not isinstance(port, int) or pid <= 1:
                raise ValueError()
            parts = (Path("/proc") / str(pid) / "cmdline").read_bytes().split(b"\0")
            if str(ROOT / "app.py").encode() in parts and is_running(port, directory):
                os.kill(pid, signal.SIGTERM)
                for _ in range(50):
                    if not is_running(port, directory):
                        break
                    time.sleep(0.1)
                print("Typewriter stopped.")
        except (OSError, ValueError, KeyError):
            print("No launcher-managed Typewriter server is running.")


def show_error(message):
    print(message, file=sys.stderr)
    import shutil
    if shutil.which("zenity"):
        subprocess.run(["zenity", "--error", "--title=Typewriter", "--text=" + message], check=False)
    elif shutil.which("notify-send"):
        subprocess.run(["notify-send", "Typewriter could not open", message], check=False)


def main():
    parser = argparse.ArgumentParser(description="Open Typewriter")
    parser.add_argument("--no-browser", action="store_true", help="Start the app without opening its page")
    parser.add_argument("--stop", action="store_true", help="Stop a server started by this launcher")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("Port must be between 1 and 65535.")
    try:
        if args.stop:
            stop()
            return 0
        url = launch(args.port)
        print(url)
        if not args.no_browser:
            subprocess.run(["xdg-open", url], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return 0
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        show_error(str(error))
        return 1


if __name__ == "__main__":
    sys.exit(main())
