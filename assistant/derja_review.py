"""Derja review loop: make a sample sheet for a Tunisian speaker, then import their answers.

    python assistant/derja_review.py sample          # -> data/derja_review_sample.csv (50 per state)
    # the reviewer fills the last 4 columns in Excel and saves as CSV (UTF-8)
    python assistant/derja_review.py import data/derja_review_sample.csv
    # -> data/derja_reviewed.jsonl, used by train_risk_model.py on the next training run

Reviewer columns:
  natural        yes / no      does this sound like something a Tunisian would actually write?
  correct_state  one of: normal anxiety depression suicidal self_harm trauma stress loneliness_grief unclear
  corrected_text optional      a natural Derja rewrite when natural = no (keep the same meaning)
  notes          optional
"""
import csv
import json
import sys
from pathlib import Path

import pandas as pd

DATA = Path(__file__).resolve().parent / "data"
STATES = ["normal", "anxiety", "depression", "suicidal", "self_harm", "trauma", "stress", "loneliness_grief"]
SAMPLE = DATA / "derja_review_sample.csv"
OUT = DATA / "derja_reviewed.jsonl"


def sample(per_state: int = 50, seed: int = 7):
    df = pd.read_csv(DATA / "derja_review.csv", encoding="utf-8-sig").drop_duplicates("text")
    parts = [g.sample(min(per_state, len(g)), random_state=seed) for _, g in df.groupby("target")]
    s = pd.concat(parts).sample(frac=1, random_state=seed).reset_index(drop=True)
    out = pd.DataFrame({"id": range(1, len(s) + 1), "text": s["text"], "generated_as": s["target"],
                        "check_label": s["checked_label"], "natural": "", "correct_state": "",
                        "corrected_text": "", "notes": ""})
    out.to_csv(SAMPLE, index=False, encoding="utf-8-sig", quoting=csv.QUOTE_ALL)
    print(f"{len(out)} messages -> {SAMPLE}")
    print(out.groupby("generated_as").size().to_string())


def import_review(path: Path):
    df = pd.read_csv(path, encoding="utf-8-sig", dtype=str).fillna("")
    done = df[df["correct_state"].str.strip() != ""]
    rows, skipped = [], 0
    for _, r in done.iterrows():
        state = r["correct_state"].strip().lower()
        natural = r["natural"].strip().lower() in ("yes", "y", "oui", "1", "true")
        text = r["corrected_text"].strip() or (r["text"] if natural else "")
        if state not in STATES or not text:
            skipped += 1
            continue
        rows.append({"text": text, "mental_state": state, "language": "aeb",
                     "source": "synthetic-haiku-reviewed" if not r["corrected_text"].strip() else "reviewer-written",
                     "label_quality": "reviewed"})
    with OUT.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    nat = (done["natural"].str.lower().isin(["yes", "y", "oui", "1", "true"])).mean() if len(done) else 0
    agree = (done["correct_state"].str.strip().str.lower() == done["generated_as"]).mean() if len(done) else 0
    print(f"reviewed {len(done)}/{len(df)}; natural {nat:.0%}; reviewer agrees with generated label {agree:.0%}")
    print(f"{len(rows)} usable rows -> {OUT} ({skipped} skipped: unclear state or unnatural without a rewrite)")


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if sys.argv[1:2] == ["sample"]:
        sample()
    elif sys.argv[1:2] == ["import"] and len(sys.argv) == 3:
        import_review(Path(sys.argv[2]))
    else:
        sys.exit(__doc__)
