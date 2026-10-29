"""Starts everything needed to try the assistant on one machine, then the tester page:
auzy-risk (if its model is in assistant/models/), the API (in-memory storage; AUZY_MODE=demo: sample professionals
and tests, nothing sent to auzy-backend) and the Streamlit page. Ctrl+C stops all of them.
The keys for this run are random and stay in memory; nothing is written to disk.

    python tester/run_local.py              real Claude: set ANTHROPIC_API_KEY first (about 0.1-1 cent per message)
    python tester/run_local.py --stand-in   no cost: canned replies, to check the screens and flows

Options: --no-risk (don't start auzy-risk), --no-browser, --api-port 8080, --ui-port 8501
"""
from __future__ import annotations

import argparse
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import builtin_api

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
RISK_URL = "http://127.0.0.1:8001"


def port_free(port: int) -> bool:
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def wait_http(url: str, seconds: float) -> bool:
    deadline = time.time() + seconds
    while True:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                return r.status == 200
        except Exception:  # noqa: BLE001 (not up yet)
            if time.time() > deadline:
                return False
            time.sleep(0.5)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--stand-in", action="store_true", help="canned replies instead of Claude (no cost)")
    ap.add_argument("--no-risk", action="store_true", help="don't start auzy-risk")
    ap.add_argument("--no-browser", action="store_true", help="don't open a browser")
    ap.add_argument("--api-port", type=int, default=8080)
    ap.add_argument("--ui-port", type=int, default=8501)
    args = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)             # show each line at once, also when the output is redirected

    if not args.stand_in and not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("Set ANTHROPIC_API_KEY first (each message costs about 0.1-1 cent), or add --stand-in for canned replies at no cost.")
    for port in (args.api_port, args.ui_port):
        if not port_free(port):
            sys.exit(f"Port {port} is already in use: stop what uses it, or choose another with --api-port / --ui-port.")

    procs: list[subprocess.Popen] = []
    try:
        if args.no_risk:
            print("auzy-risk: not started; the careful model answers every message.")
        elif wait_http(f"{RISK_URL}/health", 1):
            print("auzy-risk: already running.")
        elif not (ROOT / "assistant" / "models" / "risk-xlmr" / "risk_meta.json").exists() \
                and not (ROOT / "assistant" / "models" / "risk-tfidf.joblib").exists():
            print("auzy-risk: no model in assistant/models/ (unzip auzy-risk-model-xlmr.zip there); continuing without it.")
        else:
            procs.append(subprocess.Popen([sys.executable, "-m", "uvicorn", "assistant.risk_server:app", "--host", "127.0.0.1",
                                           "--port", "8001", "--log-level", "warning"], cwd=ROOT, env={**os.environ, "PYTHONIOENCODING": "utf-8"}))
            print("auzy-risk: loading the model...")
            print("auzy-risk: ready." if wait_http(f"{RISK_URL}/health", 120)
                  else "auzy-risk: not ready after 2 minutes; the careful model answers every message meanwhile.")

        try:
            api = builtin_api.start(port=args.api_port, risk_url=RISK_URL,
                                    anthropic_key=None if args.stand_in else os.environ["ANTHROPIC_API_KEY"])
        except RuntimeError as e:
            sys.exit(f"The API could not start: {e}")
        procs.append(api.process)

        ui_env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}      # the page never needs the Claude key
        ui_env.update(AUZY_AI_URL=api.url, AUZY_AI_API_KEY=api.service_key, AUZY_AI_STAFF_TOKEN=api.staff_token,
                      AUZY_TESTER_STAND_IN="1" if args.stand_in else "")
        procs.append(subprocess.Popen([sys.executable, "-m", "streamlit", "run", "app.py", "--server.port", str(args.ui_port),
                                       "--server.address", "127.0.0.1", "--browser.gatherUsageStats", "false",
                                       "--server.headless", "true" if args.no_browser else "false"], cwd=HERE, env=ui_env))
        print(f"\nTester: http://127.0.0.1:{args.ui_port}   ({'stand-in replies, no cost' if args.stand_in else 'real Claude'}; Ctrl+C stops everything)\n")
        while all(p.poll() is None for p in procs):
            time.sleep(1)
        print("A process stopped; stopping the others.")
    except KeyboardInterrupt:
        print("\nStopping...")
    finally:
        for p in reversed(procs):
            if p.poll() is None:
                p.terminate()
        for p in procs:
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill()
        builtin_api.stop_all()                              # and the stand-in, if any


if __name__ == "__main__":
    main()
