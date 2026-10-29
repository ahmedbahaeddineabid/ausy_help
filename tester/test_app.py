"""Automated check of the tester page, driven like a user (Streamlit AppTest), against a real API process that uses
the stand-in Claude. Free; needs Node and the packages in requirements.txt.

    python tester/test_app.py
"""
from __future__ import annotations

import os
import secrets
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import stand_in_claude  # noqa: E402
from streamlit.testing.v1 import AppTest  # noqa: E402

failed = 0


def check(name: str, ok: bool, detail: str = ""):
    global failed
    print(f"{'PASS' if ok else 'FAIL'} {name}{'' if ok else f'  ({detail})'}")
    failed += 0 if ok else 1


def texts(elements) -> str:
    return " | ".join(str(e.value) for e in elements)


def main():
    claude = stand_in_claude.start()
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    service_key, staff_token = secrets.token_hex(32), secrets.token_hex(32)
    env = {**os.environ, "NODE_ENV": "development", "PORT": str(port), "HOST": "127.0.0.1", "STORE": "memory", "AUZY_MODE": "demo",
           "AUZY_AI_API_KEY": service_key, "AUZY_AI_STAFF_TOKEN": staff_token, "ANTHROPIC_API_KEY": "stand-in",
           "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{claude.server_address[1]}",
           "RISK_SERVICE_URL": "http://127.0.0.1:9"}        # risk service down: the careful model answers, its tag escalates
    api = subprocess.Popen(["node", "server/index.js"], cwd=ROOT / "auzy-ai-v2", env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    url = f"http://127.0.0.1:{port}"
    for _ in range(60):
        try:
            urllib.request.urlopen(f"{url}/v1/health", timeout=1)
            break
        except Exception:  # noqa: BLE001
            time.sleep(0.5)
    os.environ.update(AUZY_AI_URL=url, AUZY_AI_API_KEY=service_key, AUZY_AI_STAFF_TOKEN=staff_token, AUZY_TESTER_STAND_IN="1")
    try:
        at = AppTest.from_file(str(HERE / "app.py"), default_timeout=60)
        at.run()
        check("the page loads and connects to the API", not at.exception and "Connected" in texts(at.sidebar.success),
              f"{at.exception} {texts(at.sidebar.error)}")
        check("the stand-in notice is shown", "Stand-in Claude" in texts(at.info))

        at.chat_input[0].set_value("I barely sleep, I wake up at 3am").run()
        replies = [m for m in at.chat_message if m.name == "assistant"]
        check("a typed message gets a reply, with the model and cost below it",
              len(replies) == 1 and "[stand-in]" in texts(replies[0].markdown) and "claude-sonnet-5-5" in texts(replies[0].caption),
              texts(at.markdown))
        check("one credit used", at.sidebar.number_input(key="credits").value == 9)

        at.button(key="sample_4").click().run()                 # "Can you show me a professional I could talk to?"
        check("a lookup shows its cards, with names in demo mode", "Amina B." in texts(at.markdown), texts(at.markdown))

        at.button(key="sample_9").click().run()                 # crisis, English
        check("a crisis message shows the emergency banner", "190" in texts(at.error), texts(at.error))
        time.sleep(1.0)                                          # the urgent summary is written in the background
        at.button(key="refresh_conversation").click().run()
        metrics = {m.label: m.value for m in at.metric}
        check("the staff view shows the escalation", metrics.get("Escalated") == "yes", str(metrics))
        check("the urgent clinician summary is listed", any("URGENT" in e.label for e in at.expander), str([e.label for e in at.expander]))

        next(b for b in at.button if b.label == "Clear the escalation").click().run()
        check("clearing the escalation removes the banner", "190" not in texts(at.error), texts(at.error))

        at.sidebar.number_input(key="credits").set_value(1).run()
        at.chat_input[0].set_value("Thank you, that helped").run()
        check("the last credit gets a closing reply and stops the chat box",
              "pre-assessment" in texts(at.markdown) and at.chat_input[0].disabled and at.sidebar.number_input(key="credits").value == 0)
        time.sleep(1.0)                                          # the analysis runs in the background
        at.button(key="refresh_conversation").click().run()
        check("the end-of-conversation analysis and pre-diagnostic appear in the staff view",
              "Pre-diagnostic shown to the patient" in texts(at.markdown) and any("delivery: none" in e.label for e in at.expander),
              str([e.label for e in at.expander]))

        at.button(key="refresh_costs").click().run()
        metrics = {m.label: m.value for m in at.metric}
        check("the costs tab shows the spend and the budget level",
              metrics.get("Conversations") == "1" and metrics.get("Budget level") == "standard", str(metrics))

        next(b for b in at.button if b.label == "New conversation").click().run()
        check("a new conversation starts empty with 10 credits",
              not [m for m in at.chat_message] and at.sidebar.number_input(key="credits").value == 10 and not at.exception)
        check("no error anywhere on the page", not at.exception, str(at.exception))
    finally:
        api.terminate()
        api.wait(timeout=10)
        claude.shutdown()
    log = api.stdout.read().decode(errors="replace")
    check("the API log holds no patient text or key", "3am" not in log and service_key not in log and "kill myself" not in log)
    print(f"\n{'All checks passed.' if not failed else f'{failed} check(s) failed.'}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
