"""Starts the API next to the tester: in-memory storage, AUZY_MODE=demo (sample professionals and tests, nothing sent
to auzy-backend), random keys, listening on 127.0.0.1 only. run_local.py and test_app.py use it, and so does the page
itself when no AUZY_AI_URL is set (its built-in mode, which a Streamlit Community Cloud deployment runs on).

Claude: real with a key, the stand-in otherwise (no cost). In built-in mode the page also starts auzy-risk with the
small TF-IDF model (the full XLM-R model is too large for Community Cloud), so crisis phrases and risk scores work as
they do in production. Node 20.6+ comes from PATH or, where there is none (Community Cloud), from the
nodejs-wheel-binaries package. Without node_modules in auzy-ai-v2/, the API is copied to the temp folder and its
packages are installed there with npm ci; the repository itself is left untouched.
"""
from __future__ import annotations

import atexit
import hashlib
import importlib.util
import os
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from dataclasses import dataclass
from http.server import ThreadingHTTPServer
from pathlib import Path

import stand_in_claude

ROOT = Path(__file__).resolve().parent.parent
API_DIR = ROOT / "auzy-ai-v2"
TFIDF_MODEL = ROOT / "assistant" / "models" / "risk-tfidf.joblib"
RISK_URL = "http://127.0.0.1:8001"
MIN_NODE = (20, 6)                                       # as in auzy-ai-v2/package.json


def _stop(process: subprocess.Popen | None):
    if process and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()


@dataclass
class RunningApi:
    url: str
    service_key: str
    staff_token: str
    stand_in: bool
    process: subprocess.Popen
    claude: ThreadingHTTPServer | None = None
    risk: subprocess.Popen | None = None                 # auzy-risk with the small model, when start() ran it

    def alive(self) -> bool:
        return self.process.poll() is None

    def stop(self):
        _stop(self.process)
        _stop(self.risk)
        if self.claude:
            self.claude.shutdown()
            self.claude = None


_started: list[RunningApi] = []


def _child_env(**extra: str) -> dict[str, str]:
    """This process's environment for a child process, without the page's own settings (TESTER_*)."""
    return {**{k: v for k, v in os.environ.items() if not k.startswith("TESTER_")}, **extra}


def _wait_http(url: str, process: subprocess.Popen, seconds: float) -> bool:
    deadline = time.time() + seconds
    while process.poll() is None and time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2):
                return True
        except Exception:  # noqa: BLE001 (not up yet)
            time.sleep(0.5)
    return False


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


def _start_risk(output=None) -> tuple[subprocess.Popen | None, str | None]:
    """auzy-risk with the small TF-IDF model, on a free port. (None, None) when the model or its packages (fastapi,
    scikit-learn) are missing, or when it does not start: the API then has Claude screen every message."""
    if not TFIDF_MODEL.exists() or not all(importlib.util.find_spec(m) for m in ("fastapi", "sklearn", "uvicorn")):
        return None, None
    port = _free_port()
    env = _child_env(RISK_MODEL="tfidf", PYTHONIOENCODING="utf-8")
    env.pop("ANTHROPIC_API_KEY", None)                   # auzy-risk makes no Claude calls
    process = subprocess.Popen([sys.executable, "-m", "uvicorn", "assistant.risk_server:app", "--host", "127.0.0.1",
                                "--port", str(port), "--log-level", "warning"], cwd=ROOT, env=env, stdout=output, stderr=output)
    url = f"http://127.0.0.1:{port}"
    if _wait_http(f"{url}/health", process, 60):
        return process, url
    _stop(process)
    return None, None


def start(port: int = 0, anthropic_key: str | None = None, risk_url: str | None = None, own_risk: bool = False,
          output=None) -> RunningApi:
    """Starts the API and returns once it answers. Without anthropic_key the stand-in answers instead of Claude.
    risk_url: auzy-risk's address. Without it, own_risk=True starts auzy-risk with the small model; otherwise
    RISK_SERVICE_URL, else RISK_URL. output: a file for the logs (default: this process's console)."""
    node, npm = node_and_npm()
    cwd = API_DIR if (API_DIR / "node_modules").is_dir() else _api_copy(npm)
    risk = None
    if not risk_url and own_risk:
        risk, risk_url = _start_risk(output)
    port = port or _free_port()
    claude = None if anthropic_key else stand_in_claude.start()
    env = _child_env(NODE_ENV="development", PORT=str(port), HOST="127.0.0.1", STORE="memory", AUZY_MODE="demo",
                     AUZY_AI_API_KEY=secrets.token_hex(32), AUZY_AI_STAFF_TOKEN=secrets.token_hex(32),
                     RISK_SERVICE_URL=risk_url or os.environ.get("RISK_SERVICE_URL") or RISK_URL)
    if claude:
        env.update(ANTHROPIC_API_KEY="stand-in", ANTHROPIC_BASE_URL=f"http://127.0.0.1:{claude.server_address[1]}")
    else:
        env["ANTHROPIC_API_KEY"] = anthropic_key
    process = subprocess.Popen([node, "server/index.js"], cwd=cwd, env=env, stdout=output, stderr=output)
    api = RunningApi(f"http://127.0.0.1:{port}", env["AUZY_AI_API_KEY"], env["AUZY_AI_STAFF_TOKEN"], claude is not None,
                     process, claude, risk)
    _started.append(api)
    if _wait_http(f"{api.url}/v1/health", process, 60):
        return api
    api.stop()
    raise RuntimeError("it did not answer within a minute; see its log.")


@atexit.register
def stop_all():
    """Stops every API this process started, with its auzy-risk and stand-in; also runs when the process exits."""
    while _started:
        _started.pop().stop()
