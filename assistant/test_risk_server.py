"""Tests for the auzy-risk service (local model, no API calls).

    python -m assistant.test_risk_server      (from the project root)
"""
import sys

from fastapi.testclient import TestClient

from .risk_server import app, chunks, CHUNK_CHARS

client = TestClient(app)


def test_derja_crisis_phrase():
    r = client.post("/assess", json={"text": "Nheb nmout, ma3adech najjem"}).json()
    assert r["phrase"]["category"] == "suicidal" and r["phrase"]["language"] == "aeb"


def test_abuse_phrase_in_arabic_script():
    r = client.post("/assess", json={"text": "راجلي يضربني كل ليلة"}).json()
    assert r["phrase"]["category"] == "abuse"


def test_model_flags_self_harm_without_a_listed_phrase_shape():
    r = client.post("/assess", json={"text": "When it gets too much I hurt myself, but I don't want to die"}).json()
    assert r["model"]["risk"] is True and r["model"]["state"] == "self_harm"


def test_ordinary_message_no_risk():
    r = client.post("/assess", json={"text": "Work has been stressful but I'm sleeping fine"}).json()
    assert r["phrase"] is None and r["model"]["risk"] is False


def test_risk_at_the_end_of_a_long_message_is_not_cut_off():
    filler = "Work has been busy and my manager keeps adding projects. " * 12
    r = client.post("/assess", json={"text": filler + "Honestly I want to kill myself, I can't take it anymore."}).json()
    assert r["model"]["risk"] is True, r


def test_risk_at_the_end_of_a_message_near_the_size_limit_is_read():
    filler = "Work has been busy and my manager keeps adding projects. " * 120          # about 7,000 characters
    r = client.post("/assess", json={"text": filler + "Honestly I want to kill myself, I can't take it anymore."}).json()
    assert r["model"]["risk"] is True, r


def test_chunks_respect_the_limit_and_keep_all_text():
    text = ("This is a sentence. " * 60) + "x" * 900
    parts = chunks(text)
    assert all(len(p) <= CHUNK_CHARS for p in parts[:-1])
    assert "".join(parts).replace(" ", "") == text.replace(" ", "")


def test_validation_and_health():
    assert client.post("/assess", json={"text": ""}).status_code == 422
    h = client.get("/health").json()
    assert h["ok"] and h["model"] in ("xlmr", "tfidf")


if __name__ == "__main__":
    failed = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            try:
                fn()
                print(f"PASS {name}")
            except AssertionError as e:
                failed += 1
                print(f"FAIL {name}: {e}")
    sys.exit(failed)
