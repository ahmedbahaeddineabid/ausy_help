"""Starts the API next to the tester: in-memory storage, AUZY_MODE=demo (sample professionals and tests, nothing sent
to auzy-backend), random keys, listening on 127.0.0.1 only. run_local.py and test_app.py use it, and so does the page
itself when no AUZY_AI_URL is set (its built-in mode, which a Streamlit Community Cloud deployment runs on).

Claude: real with a key, the stand-in otherwise (no cost). Node 20.6+ comes from PATH or, where there is none
(Community Cloud), from the nodejs-wheel-binaries package. Without node_modules in auzy-ai-v2/, the API is copied to
the temp folder and its packages are installed there with npm ci; the repository itself is left untouched.
"""
from __future__ import annotations

import atexit
import hashlib
import os
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
from dataclasses import dataclass
from http.server import ThreadingHTTPServer
from pathlib import Path

import stand_in_claude

API_DIR = Path(__file__).resolve().parent.parent / "auzy-ai-v2"
RISK_URL = "http://127.0.0.1:8001"
MIN_NODE = (20, 6)                                       # as in auzy-ai-v2/package.json


@dataclass
class RunningApi:
    url: str
    service_key: str
    staff_token: str
    stand_in: bool
    process: subprocess.Popen
    claude: ThreadingHTTPServer | None = None

    def alive(self) -> bool:
        return self.process.poll() is None

    def stop(self):
        if self.alive():
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
        if self.claude:
            self.claude.shutdown()
            self.claude = None


_started: list[RunningApi] = []


def _node_version(node: str) -> tuple[int, ...]:
    try:
        out = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=30).stdout
        return tuple(int(x) for x in out.strip().lstrip("v").split(".")[:2])
    except (OSError, ValueError, subprocess.SubprocessError):
        return ()


def node_and_npm() -> tuple[str, list[str]]:
    """Node 20.6+ from PATH, else from the nodejs-wheel-binaries package; and the npm command that goes with it."""
    node = shutil.which("node")
    if node and _node_version(node) >= MIN_NODE:
        npm = shutil.which("npm")
        return node, [npm] if npm else []
    try:
        from nodejs_wheel.executable import ROOT_DIR
    except ImportError:
        raise RuntimeError("it needs Node 20.6 or newer. Install it from https://nodejs.org, "
                           "or pip install nodejs-wheel-binaries.") from None
    node = os.path.join(ROOT_DIR, "node.exe") if os.name == "nt" else os.path.join(ROOT_DIR, "bin", "node")
    return node, [node, os.path.join(ROOT_DIR, "lib", "node_modules", "npm", "bin", "npm-cli.js")]


def _api_copy(npm: list[str]) -> Path:
    """A copy of the API with its packages installed, in the temp folder; reused while the code is unchanged."""
    files = sorted(p for d in ("server", "src") for p in (API_DIR / d).rglob("*") if p.is_file())
    files += [API_DIR / "package.json", API_DIR / "package-lock.json"]
    digest = hashlib.sha256()
    for p in files:
        digest.update(p.relative_to(API_DIR).as_posix().encode() + b"\0" + p.read_bytes())
    work = Path(tempfile.gettempdir()) / "auzy-ai-tester" / f"api-{digest.hexdigest()[:16]}"
    if (work / ".ready").exists():
        return work
    if not npm:
        raise RuntimeError("it needs npm to install its packages, or run npm ci --omit=dev in auzy-ai-v2/ first.")
    shutil.rmtree(work, ignore_errors=True)
    for p in files:
        target = work / p.relative_to(API_DIR)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(p, target)
    done = subprocess.run([*npm, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-update-notifier"],
                          cwd=work, capture_output=True, encoding="utf-8", errors="replace", timeout=600)
    if done.returncode:
        raise RuntimeError(f"npm ci failed: {(done.stderr or done.stdout).strip()[-600:]}")
    (work / ".ready").touch()
    return work


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start(port: int = 0, anthropic_key: str | None = None, risk_url: str | None = None, output=None) -> RunningApi:
    """Starts the API and returns once it answers. Without anthropic_key the stand-in answers instead of Claude.
    risk_url: auzy-risk (default: RISK_SERVICE_URL, else RISK_URL). output: a file for the API's log (default: this
    process's console)."""
    node, npm = node_and_npm()
    cwd = API_DIR if (API_DIR / "node_modules").is_dir() else _api_copy(npm)
    port = port or _free_port()
    claude = None if anthropic_key else stand_in_claude.start()
    env = {k: v for k, v in os.environ.items() if not k.startswith("TESTER_")}       # the page's own settings stay with it
    env.update(NODE_ENV="development", PORT=str(port), HOST="127.0.0.1", STORE="memory", AUZY_MODE="demo",
               AUZY_AI_API_KEY=secrets.token_hex(32), AUZY_AI_STAFF_TOKEN=secrets.token_hex(32),
               RISK_SERVICE_URL=risk_url or os.environ.get("RISK_SERVICE_URL") or RISK_URL)
    if claude:
        env.update(ANTHROPIC_API_KEY="stand-in", ANTHROPIC_BASE_URL=f"http://127.0.0.1:{claude.server_address[1]}")
    else:
        env["ANTHROPIC_API_KEY"] = anthropic_key
    process = subprocess.Popen([node, "server/index.js"], cwd=cwd, env=env, stdout=output, stderr=output)
    api = RunningApi(f"http://127.0.0.1:{port}", env["AUZY_AI_API_KEY"], env["AUZY_AI_STAFF_TOKEN"], claude is not None,
                     process, claude)
    _started.append(api)
    deadline = time.time() + 60
    while api.alive() and time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{api.url}/v1/health", timeout=2):
                return api
        except Exception:  # noqa: BLE001 (not up yet)
            time.sleep(0.5)
    api.stop()
    raise RuntimeError("it did not answer within a minute; see its log.")


@atexit.register
def stop_all():
    """Stops every API this process started; also runs when the process exits."""
    while _started:
        _started.pop().stop()
