"""Merge every local source into one dataset for a mental-state text classifier.

Sources (paths relative to the project root, one level above mh_dataset/):
  dataset.csv                 Reddit posts from depression communities (no labels)
  train.txt / val.txt / test.txt   Emotion dataset, "text;emotion"
  mh_dataset/data/build/train_classifier.jsonl   Seed screening records (PHQ-9/GAD-7)

Target label `mental_state`: normal | anxiety | depression | suicidal
`label_quality` says how much to trust it: gold (questionnaire scores) or weak (rules / proxy).

Usage: python mh_dataset/scripts/merge_all.py [--root DIR] [--out DIR]
"""
import argparse
import json
import re
from pathlib import Path

import pandas as pd
from sklearn.model_selection import train_test_split

SUICIDAL = re.compile(
    r"\b(kill(ing)? myself|suicid\w*|end(ing)? (it all|my life)|want(ed)? to die|"
    r"wish i (was|were) dead|better off dead|take my (own )?life|no reason to live|"
    r"don'?t want to (live|be alive|exist))\b", re.I)
ANXIETY = re.compile(r"\b(anxi\w*|panic\w*|worr(y|ied|ying)|nervous|overthink\w*|heart racing)\b", re.I)
DEPRESSION = re.compile(
    r"\b(depress\w*|hopeless\w*|empty|numb|worthless|no motivation|can'?t get out of bed|"
    r"sad(ness)?|lonely|tired of everything|pointless)\b", re.I)
NOISE = re.compile(r"\b(survey|questionnaire|research (study|opportunity)|participants|check-in post|"
                   r"our rules|subreddit|giveaway)\b", re.I)

EMOTION_TO_STATE = {"joy": "normal", "love": "normal", "surprise": "normal"}  # others are not clinical


def clean(text: str) -> str:
    text = re.sub(r"https?://\S+", "<url>", str(text))
    text = re.sub(r"u/\w+", "<user>", text)
    return re.sub(r"\s+", " ", text).strip()


def load_reddit(root: Path) -> pd.DataFrame:
    df = pd.read_csv(root / "dataset.csv")
    df["text"] = (df["title"].fillna("") + ". " + df["content"].fillna("")).map(clean)
    df = df[~df["text"].str.contains(NOISE)]
    df = df[df["text"].str.len().between(30, 5000)]

    def rule(t):
        if SUICIDAL.search(t):
            return "suicidal"
        a, d = len(ANXIETY.findall(t)), len(DEPRESSION.findall(t))
        return "anxiety" if a > d else "depression"

    return pd.DataFrame({
        "text": df["text"], "mental_state": df["text"].map(rule), "emotion": None,
        "source": "reddit", "language": "en", "label_quality": "weak",
    })


def load_emotion(root: Path) -> pd.DataFrame:
    parts = [pd.read_csv(root / f, sep=";", header=None, names=["text", "emotion"]) for f in
             ("train.txt", "val.txt", "test.txt")]
    df = pd.concat(parts, ignore_index=True)
    return pd.DataFrame({
        "text": df["text"].map(clean), "mental_state": df["emotion"].map(EMOTION_TO_STATE),
        "emotion": df["emotion"], "source": "emotion", "language": "en", "label_quality": "weak",
    })


GO_NAMES = ["admiration", "amusement", "anger", "annoyance", "approval", "caring", "confusion",
            "curiosity", "desire", "disappointment", "disapproval", "disgust", "embarrassment",
            "excitement", "fear", "gratitude", "grief", "joy", "love", "nervousness", "optimism",
            "pride", "realization", "relief", "remorse", "sadness", "surprise", "neutral"]
GO_NORMAL = {"neutral", "joy", "amusement", "gratitude", "approval", "admiration", "optimism", "love",
             "excitement", "relief", "pride", "caring", "curiosity"}


def load_goemotions(root: Path) -> pd.DataFrame:
    """Reddit comments (Apache 2.0) whose labels are all neutral or positive -> normal."""
    ext = root / "mh_dataset" / "data" / "external"
    files = sorted(ext.glob("go_emotions_*.jsonl"))
    if not files:
        return pd.DataFrame()
    df = pd.concat([pd.read_json(f, lines=True) for f in files], ignore_index=True)
    names = df["labels"].map(lambda ls: [GO_NAMES[i] for i in ls])
    df = df[names.map(lambda ns: bool(ns) and set(ns) <= GO_NORMAL)]
    text = df["text"].map(clean).str.replace(r"\[NAME\]", "<user>", regex=True)
    return pd.DataFrame({
        "text": text, "mental_state": "normal", "emotion": names[df.index].map(",".join),
        "source": "goemotions", "language": "en", "label_quality": "weak",
    })


def load_mentalchat(root: Path) -> pd.DataFrame:
    """Patient descriptions from MentalChat16K (MIT). No labels: auxiliary rows only."""
    path = root / "mh_dataset" / "data" / "external" / "mentalchat16k_train.jsonl"
    if not path.exists():
        return pd.DataFrame()
    df = pd.read_json(path, lines=True)
    return pd.DataFrame({
        "text": df["input"].map(clean), "mental_state": None, "emotion": None,
        "source": "mentalchat16k", "language": "en", "label_quality": "none",
    })


def rebalance(lab: pd.DataFrame, ratio: float, seed: int) -> pd.DataFrame:
    """Cap each class at `ratio` x the smallest one, sampling evenly across its sources."""
    cap = int(lab["mental_state"].value_counts().min() * ratio)
    parts = []
    for _, g in lab.groupby("mental_state"):
        if len(g) <= cap or (g["label_quality"] == "gold").all():
            parts.append(g)
            continue
        gold = g[g["label_quality"] == "gold"]
        weak = g[g["label_quality"] != "gold"]
        per_src = weak.groupby("source")
        share = cap // per_src.ngroups
        take = pd.concat([s.sample(min(len(s), share), random_state=seed) for _, s in per_src])
        rest = weak.drop(take.index)
        if len(take) < cap and len(rest):
            take = pd.concat([take, rest.sample(min(len(rest), cap - len(take)), random_state=seed)])
        parts.append(pd.concat([take, gold]))
    return pd.concat(parts)


def shortcut_check(train: pd.DataFrame, test: pd.DataFrame) -> str:
    """Can surface style alone (length, case, punctuation) predict the label? It should not."""
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import f1_score
    import numpy as np

    def feats(s: pd.Series):
        return np.c_[np.log1p(s.str.len()), s.str.count(r"[A-Z]") / (s.str.len() + 1),
                     s.str.count(r"[.,!?']") / (s.str.len() + 1), s.str.count(r"<url>|<user>")]

    clf = LogisticRegression(max_iter=1000, class_weight="balanced")
    clf.fit(feats(train["text"]), train["mental_state"])
    f1 = f1_score(test["mental_state"], clf.predict(feats(test["text"])), average="macro")
    chance = 1 / train["mental_state"].nunique()
    verdict = "OK" if f1 < chance + 0.15 else "WARNING: style alone predicts the label"
    return f"style-only macro-F1 {f1:.2f} (chance about {chance:.2f}) -> {verdict}"


def seed_state(r: dict) -> str:
    if r.get("suicide_risk", "none") != "none":
        return "suicidal"
    phq, gad = r.get("phq9_total", 0), r.get("gad7_total", 0)
    if max(phq, gad) < 5:
        return "normal"
    return "anxiety" if gad > phq else "depression"


def load_seed(root: Path) -> pd.DataFrame:
    path = root / "mh_dataset" / "data" / "build" / "train_classifier.jsonl"
    rows = [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]
    return pd.DataFrame([{
        "text": clean(r["text"]), "mental_state": seed_state(r), "emotion": None,
        "source": "seed", "language": r.get("language", "en"), "label_quality": "gold",
        "phq9_total": r.get("phq9_total"), "gad7_total": r.get("gad7_total"),
        "suicide_risk": r.get("suicide_risk"),
    } for r in rows])


def main():
    here = Path(__file__).resolve().parents[2]
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", type=Path, default=here)
    ap.add_argument("--out", type=Path, default=here / "mh_dataset" / "data" / "combined")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--balance-ratio", type=float, default=3.0,
                    help="cap each class at this many times the smallest class (0 = no cap)")
    ap.add_argument("--max-chars", type=int, default=0,
                    help="truncate texts to about this many characters (0 = keep full text)")
    args = ap.parse_args()

    df = pd.concat([load_reddit(args.root), load_emotion(args.root), load_goemotions(args.root),
                    load_mentalchat(args.root), load_seed(args.root)], ignore_index=True)
    if args.max_chars:
        # Long posts vs short comments lets a model guess the label from length; cut at a sentence end.
        df["text"] = df["text"].map(lambda t: t if len(t) <= args.max_chars else
                                    (t[:args.max_chars].rsplit(". ", 1)[0] + "."))
        # A rule-labelled suicidal post must still contain the phrase that earned the label.
        lost = (df["source"] == "reddit") & (df["mental_state"] == "suicidal") & ~df["text"].str.contains(SUICIDAL)
        print(f"dropping {lost.sum()} suicidal posts whose key phrase was cut off")
        df = df[~lost]
    df = df[df["text"].str.len() >= 10].drop_duplicates("text").reset_index(drop=True)
    args.out.mkdir(parents=True, exist_ok=True)

    # Everything, including rows with no clinical label (useful for auxiliary/multi-task training).
    df.to_csv(args.out / "all_with_aux.csv", index=False, encoding="utf-8")

    lab = df[df["mental_state"].notna()].copy()
    if args.balance_ratio:
        lab = rebalance(lab, args.balance_ratio, args.seed)
    # Gold seed rows stay in train: too few to evaluate on (see README).
    gold, weak = lab[lab["label_quality"] == "gold"], lab[lab["label_quality"] != "gold"]
    train, rest = train_test_split(weak, test_size=0.2, stratify=weak["mental_state"], random_state=args.seed)
    val, test = train_test_split(rest, test_size=0.5, stratify=rest["mental_state"], random_state=args.seed)
    train = pd.concat([train, gold]).sample(frac=1, random_state=args.seed)
    for name, part in (("train", train), ("validation", val), ("test", test)):
        part.to_csv(args.out / f"{name}.csv", index=False, encoding="utf-8")

    lines = ["# Combined dataset summary", "", f"Labelled rows: {len(lab)}  |  all rows (incl. aux): {len(df)}", ""]
    for name, part in (("train", train), ("validation", val), ("test", test)):
        lines.append(f"- {name}: {len(part)}")
    for col in ("mental_state", "source", "label_quality", "language"):
        lines += ["", f"## {col}", ""] + [f"- {k}: {v}" for k, v in lab[col].value_counts().items()]
    lines += ["", "## mental_state by source", "", "```",
              pd.crosstab(lab["source"], lab["mental_state"]).to_string(), "```",
              "", "## Shortcut check", "", shortcut_check(train, test)]
    (args.out / "SUMMARY.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
