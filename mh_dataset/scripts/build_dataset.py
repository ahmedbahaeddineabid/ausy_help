"""Merge every source in data/sources/ into train/validation/test splits.

    python scripts/build_dataset.py                     # commercial-safe sources only
    python scripts/build_dataset.py --include-noncommercial --out data/build_research

- Validates every record and drops invalid ones (reported).
- Drops records whose license does not allow commercial use, unless told otherwise.
- Removes exact duplicate conversations.
- Splits by group_id (one patient never appears in two splits), stratified by
  language x severity so every split has every language and the risk cases.
- Writes full conversations plus a flat "classifier" view (patient text only, so the
  model cannot learn from the bot's questions) and a datasheet with counts.
"""
import argparse, collections, hashlib, json, random, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from mhds.schema import validate


def stratum(rec):
    lab = rec["labels"]
    if rec["task"] != "screening":
        sev = rec["task"]
    elif lab.get("suicide_risk") not in (None, "none"):
        sev = "risk"
    else:
        sev = lab.get("phq9_severity") or ("phq8_" + str((lab.get("phq8_total") or 0) >= 10))
    return f"{rec['language']}|{sev}"


def split_groups(records, ratios, rng):
    by_stratum = collections.defaultdict(list)
    seen = set()
    for r in records:
        if r["group_id"] not in seen:
            seen.add(r["group_id"])
            by_stratum[stratum(r)].append(r["group_id"])
    assign = {}
    for groups in by_stratum.values():
        rng.shuffle(groups)
        n = len(groups)
        n_test = max(1, round(n * ratios[2])) if n >= 3 else 0
        n_val = max(1, round(n * ratios[1])) if n >= 3 else 0
        for i, g in enumerate(groups):
            assign[g] = "test" if i < n_test else "validation" if i < n_test + n_val else "train"
    return assign


def classifier_view(rec):
    lab = rec["labels"]
    return {
        "id": rec["id"], "language": rec["language"], "source": rec["source"],
        "text": "\n".join(t["text"] for t in rec["turns"] if t["role"] == "patient"),
        "phq9_items": lab.get("phq9_items"), "phq9_total": lab.get("phq9_total"),
        "phq8_total": lab.get("phq8_total"), "gad7_items": lab.get("gad7_items"),
        "gad7_total": lab.get("gad7_total"), "suicide_risk": lab.get("suicide_risk"),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sources", default=str(ROOT / "data" / "sources"))
    ap.add_argument("--out", default=str(ROOT / "data" / "build"))
    ap.add_argument("--include-noncommercial", action="store_true")
    ap.add_argument("--ratios", nargs=3, type=float, default=[0.8, 0.1, 0.1])
    ap.add_argument("--seed", type=int, default=13)
    args = ap.parse_args()

    records, report = [], collections.Counter()
    hashes = set()
    for path in sorted(Path(args.sources).glob("*.jsonl")):
        for line in path.open(encoding="utf-8"):
            if not line.strip():
                continue
            rec = json.loads(line)
            errs = validate(rec)
            if errs:
                report[f"invalid ({path.name})"] += 1
                continue
            if not rec["commercial_ok"] and not args.include_noncommercial:
                report[f"excluded non-commercial ({rec['source']})"] += 1
                continue
            h = hashlib.sha1(json.dumps(rec["turns"], ensure_ascii=False).encode()).hexdigest()
            if h in hashes:
                report["duplicates removed"] += 1
                continue
            hashes.add(h)
            records.append(rec)
    if not records:
        sys.exit("No records. Run the import/generate scripts first.")

    assign = split_groups(records, args.ratios, random.Random(args.seed))
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    files = {}
    for split in ("train", "validation", "test"):
        files[split] = (open(out / f"{split}.jsonl", "w", encoding="utf-8"),
                        open(out / f"{split}_classifier.jsonl", "w", encoding="utf-8"))
    counts = collections.Counter()
    for r in records:
        split = assign[r["group_id"]]
        r["split"] = split
        full, flat = files[split]
        full.write(json.dumps(r, ensure_ascii=False) + "\n")
        if r["task"] == "screening":
            flat.write(json.dumps(classifier_view(r), ensure_ascii=False) + "\n")
        lab = r["labels"]
        counts[("split", split)] += 1
        counts[("source", r["source"])] += 1
        counts[("language", r["language"])] += 1
        counts[("task", r["task"])] += 1
        if r["task"] == "screening":
            counts[("phq9_severity", lab.get("phq9_severity") or "n/a (PHQ-8 only)")] += 1
            counts[("gad7_severity", lab.get("gad7_severity") or "n/a")] += 1
            counts[("suicide_risk", lab.get("suicide_risk") or "n/a")] += 1
    for a, b in files.values():
        a.close(); b.close()

    # leakage check: no group in two splits
    g2s = collections.defaultdict(set)
    for r in records:
        g2s[r["group_id"]].add(r["split"])
    assert all(len(s) == 1 for s in g2s.values()), "group leakage across splits"

    lines = ["# Dataset build summary", "",
             f"Total records: {len(records)}  |  commercial-safe only: "
             f"{not args.include_noncommercial}", ""]
    for key in ("split", "source", "language", "task", "phq9_severity", "gad7_severity",
                "suicide_risk"):
        lines.append(f"## {key}")
        lines += [f"- {k[1]}: {v}" for k, v in sorted(counts.items()) if k[0] == key]
        lines.append("")
    if report:
        lines.append("## Dropped")
        lines += [f"- {k}: {v}" for k, v in report.items()]
    (out / "BUILD_SUMMARY.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
