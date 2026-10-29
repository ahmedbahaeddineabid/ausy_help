"""auzy-risk: the safety checks Auzy AI v2 (auzy-ai-v2/, Node) calls for every patient message.

    POST /assess  {"text": "..."}
        -> {"phrase": {"category", "language", "match"} | null,
            "model":  {"risk", "risk_score", "state"},
            "model_kind": "xlmr" | "tfidf"}
    GET  /health

    python -m uvicorn assistant.risk_server:app --host 0.0.0.0 --port 8001

Runs entirely locally: no API calls, no cost per message. Keep it on the internal network only.
Long messages are scored in chunks (the model reads at most 128 tokens), so a risk sentence at the end of a
long message is not cut off; the chunk with the highest risk score is reported.
"""
from __future__ import annotations

import re

from fastapi import FastAPI
from pydantic import BaseModel, Field

from .risk_model import RiskModel
from .safety import check

CHUNK_CHARS = 350          # about 100 tokens for Latin-script text, under the model's 128-token limit
MAX_CHUNKS = 24            # 24 x 350 covers the 8,000-character limit below (and the API's)

app = FastAPI(title="auzy-risk", docs_url=None, redoc_url=None)
model = RiskModel.load()


def chunks(text: str) -> list[str]:
    """Sentence-aligned pieces of at most CHUNK_CHARS characters."""
    text = text.strip()
    if len(text) <= CHUNK_CHARS:
        return [text]
    sentences = [s for s in re.split(r"(?<=[.!?؟…\n])\s+", text) if s.strip()]
    out, current = [], ""
    for s in sentences:
        while len(s) > CHUNK_CHARS:                      # one very long "sentence": hard split
            if current:
                out.append(current)
                current = ""
            out.append(s[:CHUNK_CHARS])
            s = s[CHUNK_CHARS:]
        if len(current) + len(s) + 1 > CHUNK_CHARS and current:
            out.append(current)
            current = s
        else:
            current = f"{current} {s}".strip()
    if current:
        out.append(current)
    return out[:MAX_CHUNKS - 1] + [" ".join(out[MAX_CHUNKS - 1:])] if len(out) > MAX_CHUNKS else out


class AssessIn(BaseModel):
    text: str = Field(min_length=1, max_length=8000)


@app.post("/assess")
def assess(body: AssessIn):
    preds = model.predict_many(chunks(body.text))
    worst = max(preds, key=lambda p: p["risk_score"])
    return {
        "phrase": check(body.text),
        "model": {"risk": worst["risk"], "risk_score": worst["risk_score"], "state": worst["state"]},
        "model_kind": model.kind,
    }


@app.get("/health")
def health():
    return {"ok": True, "model": model.kind, "threshold": model.threshold, "risk_labels": model.risk_labels}
