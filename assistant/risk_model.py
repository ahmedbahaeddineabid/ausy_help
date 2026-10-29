"""Risk detection for incoming patient messages. Runs locally, costs nothing per message.

    from assistant.risk_model import RiskModel
    rm = RiskModel.load()                 # xlmr if trained, else tfidf; or RISK_MODEL=tfidf|xlmr
    rm.predict("I don't see the point of living anymore")
    # {'probs': {...8 states...}, 'state': 'suicidal', 'risk_score': 0.93, 'risk': True, 'model': 'xlmr'}
    # risk_score = p(suicidal) + p(self_harm): both need a clinician.

This is ONE of the router's risk checks, never the only one: it was trained on weak,
mostly English labels. Crisis-phrase lists and the chat model's own flag also escalate.

    python assistant/risk_model.py "message to score" ["another message" ...]
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

MODELS = Path(__file__).resolve().parent / "models"


class RiskModel:
    def __init__(self, kind: str, proba, labels: list[str], threshold: float,
                 risk_labels: list[str] | None = None):
        self.kind, self._proba, self.labels, self.threshold = kind, proba, labels, threshold
        self.risk_labels = risk_labels or ["suicidal"]

    @classmethod
    def load(cls, kind: str | None = None) -> "RiskModel":
        kind = kind or os.environ.get("RISK_MODEL") or (
            "xlmr" if (MODELS / "risk-xlmr" / "risk_meta.json").exists() else "tfidf")
        return cls._load_xlmr() if kind == "xlmr" else cls._load_tfidf()

    @classmethod
    def _load_tfidf(cls) -> "RiskModel":
        import joblib
        path = MODELS / "risk-tfidf.joblib"
        if not path.exists():
            raise FileNotFoundError(f"{path} missing: run python assistant/train_risk_model.py --model tfidf")
        m = joblib.load(path)
        return cls("tfidf", lambda texts: m["pipeline"].predict_proba(texts)[:, m["order"]],
                   m["labels"], m["threshold"], m.get("risk_labels"))

    @classmethod
    def _load_xlmr(cls) -> "RiskModel":
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer
        path = MODELS / "risk-xlmr"
        meta = json.loads((path / "risk_meta.json").read_text(encoding="utf-8"))
        tok = AutoTokenizer.from_pretrained(path)
        model = AutoModelForSequenceClassification.from_pretrained(path).eval()   # CPU is enough

        @torch.no_grad()
        def proba(texts):
            enc = tok(list(texts), truncation=True, max_length=meta["max_len"], padding=True,
                      return_tensors="pt")
            return torch.softmax(model(**enc).logits, -1).numpy()

        return cls("xlmr", proba, meta["labels"], meta["threshold"], meta.get("risk_labels"))

    def predict(self, text: str) -> dict:
        return self.predict_many([text])[0]

    def predict_many(self, texts: list[str]) -> list[dict]:
        idx = [self.labels.index(l) for l in self.risk_labels]
        out = []
        for row in self._proba(texts):
            score = float(row[idx].sum())
            out.append({"probs": {l: round(float(p), 4) for l, p in zip(self.labels, row)},
                        "state": self.labels[int(row.argmax())],
                        "risk_score": round(score, 4), "risk": bool(score >= self.threshold),
                        "model": self.kind})
        return out


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    rm = RiskModel.load()
    print(f"model {rm.kind}, risk = {' + '.join(rm.risk_labels)}, threshold {rm.threshold:.4f}")
    for text, r in zip(sys.argv[1:], rm.predict_many(sys.argv[1:])):
        print(f"{'RISK' if r['risk'] else 'ok  '}  risk={r['risk_score']:.3f}  state={r['state']:<16} | {text}")
