"""Train the risk-detection models used to route patient messages.

Two models, same labels (8 mental states):
  tfidf  character n-gram TF-IDF + logistic regression. Seconds to train; the fallback.
  xlmr   fine-tuned xlm-roberta-base (multilingual). Needs torch; a GPU makes it fast.

Data: the real/weak-labelled set in mh_dataset/data/combined/ (4 states) plus the checked
synthetic messages in assistant/data/labelled_messages.jsonl (8 states, en/fr/ar).

Risk = suicidal or self_harm (both need a clinician). The risk threshold is calibrated on the
validation set for at least --target-recall, capped at MAX_THRESHOLD. Reported separately:
the real test set, the synthetic test set (scores look better there), the held-out seed
conversations, and a fixed list of hard cases in all 4 languages.

    python assistant/train_risk_model.py --model tfidf
    python assistant/train_risk_model.py --model xlmr
    python assistant/train_risk_model.py --model xlmr --eval-only     # re-calibrate a saved model
"""
import argparse
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import classification_report, precision_score, recall_score
from sklearn.model_selection import train_test_split

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
MODELS = HERE / "models"
SYNTHETIC = HERE / "data" / "labelled_messages.jsonl"
DERJA_REVIEWED = HERE / "data" / "derja_reviewed.jsonl"
LABELS = ["normal", "anxiety", "depression", "suicidal", "self_harm", "trauma", "stress", "loneliness_grief"]
RISK_LABELS = ["suicidal", "self_harm"]
RISK_IDX = [LABELS.index(l) for l in RISK_LABELS]
MAX_THRESHOLD = 0.5   # calibration sits on the edge of the target; a false alarm only costs a Sonnet turn

# Messages the first model missed, plus no-risk controls, in all 4 languages. Written before the
# synthetic data was generated; never used for training or calibration.
HARD_CASES = [
    ("I want to kill myself, I can't take it anymore", "en", True),
    ("A few times I thought it would be easier if I didn't wake up", "en", True),
    ("When it gets too much I hurt myself, but I don't want to die", "en", True),
    ("Work has been stressful but I'm sleeping fine", "en", False),
    ("I can't stop worrying, my chest is tight every day", "en", False),
    ("Je veux mourir, je n'en peux plus", "fr", True),
    ("Quelques fois je me suis dit que ce serait plus simple de ne pas me réveiller", "fr", True),
    ("Je suis fatiguée et triste depuis des semaines", "fr", False),
    ("أريد أن أنهي حياتي", "ar", True),
    ("الخدمة متعبة برشا أما نرقد مليح", "ar", False),
    ("Nheb nmout, ma3adech najjem", "aeb", True),
    ("Labes, el 7amdoulillah, juste chwaya stress mta3 el khedma", "aeb", False),
]


def load_data(data: Path, seed: int):
    real = {}
    for split in ("train", "validation", "test"):
        df = pd.read_csv(data / f"{split}.csv").dropna(subset=["text", "mental_state"])
        real[split] = df[df["source"] != "seed"].assign(part="real")   # seeds are a held-out check
    syn = pd.read_json(SYNTHETIC, lines=True)
    if DERJA_REVIEWED.exists():                       # written by derja_review.py import
        syn = pd.concat([syn, pd.read_json(DERJA_REVIEWED, lines=True)], ignore_index=True)
    syn = syn.drop_duplicates("text").assign(part="synthetic")
    syn = syn[syn["mental_state"].isin(LABELS)]
    strat = syn["mental_state"] + "|" + syn["language"]
    s_train, s_rest = train_test_split(syn, test_size=0.2, stratify=strat, random_state=seed)
    s_val, s_test = train_test_split(s_rest, test_size=0.5,
                                     stratify=s_rest["mental_state"] + "|" + s_rest["language"],
                                     random_state=seed)
    cols = ["text", "mental_state", "language", "part"]
    train = pd.concat([real["train"][cols], s_train[cols]]).sample(frac=1, random_state=seed)
    val = pd.concat([real["validation"][cols], s_val[cols]])
    return train, val, {"real": real["test"][cols], "synthetic": s_test[cols]}


def seed_conversations():
    seeds = json.loads((ROOT / "mh_dataset" / "seed" / "seed_conversations.json").read_text(encoding="utf-8"))
    return [{"id": s["id"], "language": s["language"], "risk": s["suicide_risk"] != "none",
             "messages": [t["text"] for t in s["turns"] if t["role"] == "patient"]} for s in seeds]


def calibrate(score: np.ndarray, positive: np.ndarray, target: float) -> float:
    """Highest threshold whose recall on positives is >= target."""
    for t in sorted(set(np.round(score, 4)), reverse=True):
        if (score[positive] >= t).mean() >= target:
            return float(t)
    return 0.0


def risk_score(p: np.ndarray) -> np.ndarray:
    return p[:, RISK_IDX].sum(1)


def evaluate(name: str, predict_proba, val, tests: dict, target: float) -> tuple[float, list[str]]:
    pv = predict_proba(val["text"].tolist())
    thr = min(calibrate(risk_score(pv), val["mental_state"].isin(RISK_LABELS).to_numpy(), target),
              MAX_THRESHOLD)
    lines = [f"## {name}", "",
             f"Risk = {' + '.join(RISK_LABELS)}. Threshold (calibrated for {target:.0%} recall on "
             f"validation, capped at {MAX_THRESHOLD}): {thr:.4f}", ""]

    for part, test in tests.items():
        pt = predict_proba(test["text"].tolist())
        y = test["mental_state"].to_numpy()
        pred = np.array(LABELS)[pt.argmax(1)]
        flag, true = risk_score(pt) >= thr, np.isin(y, RISK_LABELS)
        present = [l for l in LABELS if l in set(y)]
        lines += [f"### Test set: {part} ({len(test)} messages)", "",
                  f"Risk flag: recall {recall_score(true, flag):.3f}, precision "
                  f"{precision_score(true, flag, zero_division=0):.3f}", "", "```",
                  classification_report(y, pred, labels=present, digits=3, zero_division=0), "```", ""]
        if part == "synthetic":
            lines += ["Risk recall by language (synthetic test):", ""]
            for lang in sorted(test["language"].unique()):
                m = (test["language"] == lang).to_numpy() & true
                if m.any():
                    lines.append(f"- {lang}: {flag[m].mean():.3f} of {m.sum()} risk messages flagged")
            lines.append("")

    lines += ["### Seed conversations (held out; flagged = any patient message over threshold)", "",
              "| conversation | lang | expected | flagged | max risk score |", "|---|---|---|---|---|"]
    ok = 0
    for conv in seed_conversations():
        s = risk_score(predict_proba(conv["messages"]))
        flagged = bool((s >= thr).any())
        ok += flagged == conv["risk"]
        lines.append(f"| {conv['id']} | {conv['language']} | {'risk' if conv['risk'] else 'no risk'} | "
                     f"{'YES' if flagged else 'no'}{'' if flagged == conv['risk'] else ' ✗'} | {s.max():.3f} |")
    lines += ["", f"Seed agreement: {ok}/16", "", "### Hard cases", "",
              "| message | lang | expected | flagged | risk score | top state |", "|---|---|---|---|---|---|"]
    ph = predict_proba([t for t, _, _ in HARD_CASES])
    ok = 0
    for (text, lang, risk), p in zip(HARD_CASES, ph):
        s = float(p[RISK_IDX].sum())
        flagged = s >= thr
        ok += flagged == risk
        lines.append(f"| {text} | {lang} | {'risk' if risk else 'no risk'} | "
                     f"{'YES' if flagged else 'no'}{'' if flagged == risk else ' ✗'} | {s:.3f} | "
                     f"{LABELS[int(p.argmax())]} |")
    lines += ["", f"Hard-case agreement: {ok}/{len(HARD_CASES)}", ""]
    print("\n".join(lines))
    return thr, lines


def train_tfidf(train, val, tests, target: float):
    import joblib
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import make_pipeline, make_union

    pipe = make_pipeline(
        make_union(TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 5), min_df=2, sublinear_tf=True),
                   TfidfVectorizer(ngram_range=(1, 2), min_df=2, sublinear_tf=True)),
        LogisticRegression(max_iter=3000, class_weight="balanced", C=4.0))
    pipe.fit(train["text"], train["mental_state"])
    order = [list(pipe.classes_).index(l) for l in LABELS]
    proba = lambda texts: pipe.predict_proba(texts)[:, order]
    thr, report = evaluate("TF-IDF baseline", proba, val, tests, target)
    MODELS.mkdir(parents=True, exist_ok=True)
    joblib.dump({"pipeline": pipe, "order": order, "labels": LABELS, "risk_labels": RISK_LABELS,
                 "threshold": thr}, MODELS / "risk-tfidf.joblib")
    return report


def train_xlmr(train, val, tests, target: float, args):
    import torch
    from torch.utils.data import DataLoader
    from transformers import AutoModelForSequenceClassification, AutoTokenizer, get_linear_schedule_with_warmup

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"device: {dev}" + (f" ({torch.cuda.get_device_name(0)})" if dev == "cuda" else
                               "  (no GPU: this will be slow)"), flush=True)
    torch.manual_seed(args.seed)
    tok = AutoTokenizer.from_pretrained(args.base)
    model = AutoModelForSequenceClassification.from_pretrained(
        args.base, num_labels=len(LABELS), id2label=dict(enumerate(LABELS)),
        label2id={l: i for i, l in enumerate(LABELS)}).to(dev)

    y = train["mental_state"].map(LABELS.index).to_numpy()
    counts = np.bincount(y, minlength=len(LABELS))
    loss_fn = torch.nn.CrossEntropyLoss(
        weight=torch.tensor(len(y) / (len(LABELS) * np.maximum(counts, 1)), dtype=torch.float, device=dev))

    def collate(batch):
        texts, labels = zip(*batch)
        enc = tok(list(texts), truncation=True, max_length=args.max_len, padding=True, return_tensors="pt")
        enc["labels"] = torch.tensor(labels)
        return enc

    loader = DataLoader(list(zip(train["text"], y)), batch_size=args.batch, shuffle=True, collate_fn=collate)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    steps = len(loader) * args.epochs
    sched = get_linear_schedule_with_warmup(opt, int(0.06 * steps), steps)
    use_amp = dev == "cuda"
    scaler = torch.amp.GradScaler("cuda", enabled=use_amp)

    @torch.no_grad()
    def predict_proba(texts):
        model.eval()
        out = []
        for i in range(0, len(texts), 64):
            enc = tok(texts[i:i + 64], truncation=True, max_length=args.max_len, padding=True,
                      return_tensors="pt").to(dev)
            with torch.autocast(dev, enabled=use_amp):
                out.append(torch.softmax(model(**enc).logits.float(), -1).cpu().numpy())
        return np.concatenate(out)

    t0 = time.time()
    for epoch in range(args.epochs):
        model.train()
        total = 0.0
        for step, batch in enumerate(loader):
            labels = batch.pop("labels").to(dev)
            batch = batch.to(dev)
            with torch.autocast(dev, enabled=use_amp):
                loss = loss_fn(model(**batch).logits.float(), labels)
            opt.zero_grad()
            scaler.scale(loss).backward()
            scaler.unscale_(opt)
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            scaler.step(opt)
            scaler.update()
            sched.step()
            total += loss.item()
            if step % 100 == 0:
                print(f"epoch {epoch + 1}/{args.epochs} step {step}/{len(loader)} "
                      f"loss {total / (step + 1):.4f}  {time.time() - t0:.0f}s", flush=True)

    thr, report = evaluate("XLM-R (xlm-roberta-base, fine-tuned, 8 states)", predict_proba, val, tests, target)
    out = MODELS / "risk-xlmr"
    model.save_pretrained(out)
    tok.save_pretrained(out)
    (out / "risk_meta.json").write_text(json.dumps(
        {"labels": LABELS, "risk_labels": RISK_LABELS, "threshold": thr, "max_len": args.max_len,
         "base": args.base, "trained_seconds": round(time.time() - t0)}, indent=1), encoding="utf-8")
    return report


def recalibrate(kind: str, val, tests, target: float):
    """Re-run evaluation on the saved model and store the new threshold."""
    import sys
    sys.path.insert(0, str(HERE))
    from risk_model import RiskModel
    rm = RiskModel.load(kind)
    name = "TF-IDF baseline" if kind == "tfidf" else "XLM-R (xlm-roberta-base, fine-tuned, 8 states)"
    thr, report = evaluate(name, rm._proba, val, tests, target)
    if kind == "tfidf":
        import joblib
        m = joblib.load(MODELS / "risk-tfidf.joblib")
        m["threshold"] = thr
        joblib.dump(m, MODELS / "risk-tfidf.joblib")
    else:
        meta_path = MODELS / "risk-xlmr" / "risk_meta.json"
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["threshold"] = thr
        meta_path.write_text(json.dumps(meta, indent=1), encoding="utf-8")
    return report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", choices=["tfidf", "xlmr"], default="tfidf")
    ap.add_argument("--data", type=Path, default=ROOT / "mh_dataset" / "data" / "combined")
    ap.add_argument("--target-recall", type=float, default=0.95)
    ap.add_argument("--base", default="xlm-roberta-base")
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--lr", type=float, default=2e-5)
    ap.add_argument("--max-len", type=int, default=128)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--eval-only", action="store_true",
                    help="re-evaluate and re-calibrate the saved model without retraining")
    args = ap.parse_args()

    train, val, tests = load_data(args.data, args.seed)
    print(f"train {len(train)}  validation {len(val)}  test real {len(tests['real'])} / synthetic "
          f"{len(tests['synthetic'])}  (seed conversations held out)", flush=True)
    if args.eval_only:
        report = recalibrate(args.model, val, tests, args.target_recall)
    else:
        report = (train_tfidf(train, val, tests, args.target_recall) if args.model == "tfidf"
                  else train_xlmr(train, val, tests, args.target_recall, args))
    MODELS.mkdir(parents=True, exist_ok=True)
    (MODELS / f"REPORT_{args.model}.md").write_text("\n".join(report) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
