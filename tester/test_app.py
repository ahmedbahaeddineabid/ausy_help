"""Automated check of the tester page, driven like a user (Streamlit AppTest). Free: the stand-in answers instead of
Claude. Needs Node 20.6+ (or the nodejs-wheel-binaries package) and the packages in requirements.txt.

    python tester/test_app.py

First against an API that is already running (AUZY_AI_URL set, as run_local.py does), then in the page's built-in
mode, as on Streamlit Community Cloud: password, its own API, spend limit.
"""
from __future__ import annotations

import os
import secrets
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import builtin_api  # noqa: E402
import stand_in_claude  # noqa: E402
from streamlit.testing.v1 import AppTest  # noqa: E402

failed = 0
PAGE_SETTINGS = ("AUZY_AI_URL", "AUZY_AI_API_KEY", "AUZY_AI_STAFF_TOKEN", "AUZY_TESTER_STAND_IN", "ANTHROPIC_API_KEY",
                 "ANTHROPIC_BASE_URL", "TESTER_PASSWORD", "TESTER_MAX_SPEND_USD")


def check(name: str, ok: bool, detail: str = ""):
    global failed
    print(f"{'PASS' if ok else 'FAIL'} {name}{'' if ok else f'  ({detail})'}")
    failed += 0 if ok else 1


def texts(elements) -> str:
    return " | ".join(str(e.value) for e in elements)


def with_running_api():
    """The page against an API that is already running, as run_local.py starts it."""
    with tempfile.TemporaryFile() as log:
        # risk service down: the careful model answers, its tag escalates
        api = builtin_api.start(risk_url="http://127.0.0.1:9", output=log)
        os.environ.update(AUZY_AI_URL=api.url, AUZY_AI_API_KEY=api.service_key, AUZY_AI_STAFF_TOKEN=api.staff_token,
                          AUZY_TESTER_STAND_IN="1")
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
            api.stop()
        log.seek(0)
        text = log.read().decode(errors="replace")
    check("the API log holds no patient text or key", "3am" not in text and api.service_key not in text and "kill myself" not in text)


def built_in_mode():
    """No AUZY_AI_URL, as on Streamlit Community Cloud: the page starts its own API. With a key it counts as real Claude
    (for the spend limit); ANTHROPIC_BASE_URL sends those calls to the stand-in, so this costs nothing either."""
    for name in PAGE_SETTINGS:
        os.environ.pop(name, None)
    claude = stand_in_claude.start()
    os.environ["ANTHROPIC_BASE_URL"] = f"http://127.0.0.1:{claude.server_address[1]}"
    password = secrets.token_urlsafe(12)
    try:
        at = AppTest.from_file(str(HERE / "app.py"), default_timeout=300)    # the first start may install the API's packages
        at.secrets["TESTER_PASSWORD"] = password
        at.secrets["ANTHROPIC_API_KEY"] = "stand-in"
        at.secrets["TESTER_MAX_SPEND_USD"] = "0.000001"
        at.run()
        check("with TESTER_PASSWORD set, the page asks for it and shows nothing else",
              not at.exception and [t.label for t in at.text_input] == ["Password"] and not at.tabs, str(at.exception))
        at.text_input[0].set_value("not the password").run()
        check("a wrong password is refused", "Wrong password" in texts(at.error) and not at.tabs, texts(at.error))
        at.text_input[0].set_value(password).run()
        check("the right password opens the page, which starts its own API and connects to it",
              not at.exception and "Connected" in texts(at.sidebar.success) and "Built-in API" in texts(at.sidebar.caption),
              f"{at.exception} {texts(at.error)}")
        check("its address and keys can't be changed from the page", "API address" not in [t.label for t in at.sidebar.text_input])
        at.chat_input[0].set_value("I can't sleep").run()
        check("a message gets a reply", len([m for m in at.chat_message if m.name == "assistant"]) == 1, texts(at.markdown))
        at.chat_input[0].set_value("Still awake").run()
        check("past the spend limit, messages are paused",
              len([m for m in at.chat_message if m.name == "assistant"]) == 1 and "spend limit" in texts(at.warning), texts(at.warning))
        check("no error anywhere on the page", not at.exception, str(at.exception))
    finally:
        builtin_api.stop_all()
        claude.shutdown()


def main():
    with_running_api()
    built_in_mode()
    print(f"\n{'All checks passed.' if not failed else f'{failed} check(s) failed.'}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
