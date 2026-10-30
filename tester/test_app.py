"""Automated check of the tester page, driven like a user (Streamlit AppTest). Free: the stand-in answers instead of
Claude. Needs Node 20.6+ (or the nodejs-wheel-binaries package) and the packages in requirements.txt.

    python tester/test_app.py

First against an API that is already running (AUZY_AI_URL set, as run_local.py does), then in the page's built-in
mode, as on Streamlit Community Cloud: password, its own API and auzy-risk, spend limit.
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


def replies(at) -> list:
    """The assistant's replies, without the greeting that opens the conversation."""
    return [m for m in at.chat_message if m.name == "assistant" and "no Claude call" not in texts(m.caption)]


def chat_requests(claude) -> list[dict]:
    """The chat calls the stand-in received (not the analyses), oldest first."""
    return [r for r in claude.requests if not (r.get("output_config") or {}).get("format")]


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
            check("with the risk service down, no warning or error: a note says Claude screens every message",
                  not at.warning and not at.error and "Claude screens every message" in texts(at.sidebar.caption),
                  f"{texts(at.warning)} {texts(at.error)} {texts(at.sidebar.caption)}")

            opening = at.chat_message
            check("the conversation opens with the greeting: the persona's name, in the chat language, no Claude call",
                  len(opening) == 1 and "Hello, I'm Auzy, an AI support assistant." in texts(opening[0].markdown)
                  and "no Claude call" in texts(opening[0].caption), texts(at.markdown))
            at.sidebar.selectbox(key="chat_language").set_value("Français").run()
            check("before the first message, the greeting follows the chat language",
                  "Bonjour, je suis Auzy, une IA de soutien." in texts(at.chat_message[0].markdown), texts(at.markdown))

            at.chat_input[0].set_value("I barely sleep, I wake up at 3am").run()
            answers = replies(at)
            check("a typed message gets a reply, with the model and cost below it",
                  len(answers) == 1 and "[stand-in]" in texts(answers[0].markdown) and "claude-sonnet-5-5" in texts(answers[0].caption),
                  texts(at.markdown))
            check("one credit used", at.sidebar.number_input(key="credits").value == 9)
            hint = str(chat_requests(api.claude)[0]["messages"][-1].get("content"))
            check("the API told Claude which greeting the patient saw, so the first reply doesn't greet again",
                  "opened with this greeting from you:\nBonjour, je suis Auzy" in hint, hint[:300])

            at.sidebar.selectbox(key="chat_language").set_value("Derja").run()
            at.button(key="sample_4").click().run()                 # "Can you show me a professional I could talk to?"
            check("a later language change goes with the next message; the greeting stays as the patient saw it",
                  "switched the chat language to Tunisian Derja" in texts(at.caption)
                  and "Bonjour, je suis Auzy" in texts(at.chat_message[0].markdown), texts(at.caption))
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
            check("a new conversation starts with only the greeting, in the current chat language, and 10 credits",
                  len(at.chat_message) == 1 and "Aslema, ena Auzy" in texts(at.chat_message[0].markdown)
                  and at.sidebar.number_input(key="credits").value == 10 and not at.exception, texts(at.markdown))
            check("no error anywhere on the page", not at.exception, str(at.exception))
        finally:
            api.stop()
        log.seek(0)
        text = log.read().decode(errors="replace")
    check("the API log holds no patient text or key", "3am" not in text and api.service_key not in text and "kill myself" not in text)


def built_in_mode():
    """No AUZY_AI_URL, as on Streamlit Community Cloud: the page starts its own API and auzy-risk (small model). With a
    key it counts as real Claude (for the spend limit); ANTHROPIC_BASE_URL sends those calls to the stand-in, so this
    costs nothing either."""
    for name in PAGE_SETTINGS:
        os.environ.pop(name, None)
    claude = stand_in_claude.start()
    os.environ["ANTHROPIC_BASE_URL"] = f"http://127.0.0.1:{claude.server_address[1]}"
    password = secrets.token_urlsafe(12)
    try:
        at = AppTest.from_file(str(HERE / "app.py"), default_timeout=300)    # the first start may install the API's packages
        at.secrets["TESTER_PASSWORD"] = password
        at.secrets["ANTHROPIC_API_KEY"] = "stand-in"
        at.secrets["TESTER_MAX_SPEND_USD"] = "5"
        at.run()
        check("with TESTER_PASSWORD set, the page asks for it and shows nothing else",
              not at.exception and [t.label for t in at.text_input] == ["Password"] and not at.tabs, str(at.exception))
        at.text_input[0].set_value("not the password").run()
        check("a wrong password is refused", "Wrong password" in texts(at.error) and not at.tabs, texts(at.error))
        at.text_input[0].set_value(password).run()
        check("the right password opens the page, which starts its own API and connects to it",
              not at.exception and "Connected" in texts(at.sidebar.success) and "Started by this page" in texts(at.sidebar.caption),
              f"{at.exception} {texts(at.error)}")
        check("it starts auzy-risk with the small model too, and nothing on the page looks like an error",
              "risk model: the small one (TF-IDF)" in texts(at.sidebar.caption) and not at.warning and not at.error,
              f"{texts(at.sidebar.caption)} {texts(at.warning)} {texts(at.error)}")
        check("its address and keys can't be changed from the page", "API address" not in [t.label for t in at.sidebar.text_input])
        check("the chat opens with the greeting", "Hello, I'm Auzy, an AI support assistant." in texts(at.markdown), texts(at.markdown))
        at.chat_input[0].set_value("I can't sleep").run()
        answers = replies(at)
        check("with the risk service, a routine message goes to the routine model",
              len(answers) == 1 and "claude-haiku-5-5" in texts(answers[0].caption), texts(at.caption))
        at.button(key="sample_9").click().run()                 # crisis, English
        check("a crisis phrase shows the emergency banner", "190" in texts(at.error), texts(at.error))
        at.secrets["TESTER_MAX_SPEND_USD"] = "0.000001"
        at.chat_input[0].set_value("Still awake").run()
        check("past the spend limit, messages are paused",
              len(replies(at)) == 2 and "spend limit" in texts(at.warning), texts(at.warning))
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
