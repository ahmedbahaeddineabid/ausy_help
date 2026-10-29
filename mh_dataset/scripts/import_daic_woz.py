"""Convert DAIC-WOZ transcripts once you have been granted access by USC ICT.

LICENSE: academic / non-profit, non-commercial research only. These records are
marked commercial_ok = False, and build_dataset.py leaves them OUT by default.
Use them only for research benchmarking under your signed agreement.

    python scripts/import_daic_woz.py /path/to/daic_woz
Expects the folder to contain XXX_P/XXX_TRANSCRIPT.csv (or XXX_TRANSCRIPT.csv)
and the split files *_split_Depression_AVEC2017.csv.
"""
import csv, json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from mhds.schema import make_record, score_labels, validate

if len(sys.argv) != 2:
    sys.exit(__doc__)
base = Path(sys.argv[1])

ITEM_COLS = ["PHQ8_NoInterest", "PHQ8_Depressed", "PHQ8_Sleep", "PHQ8_Tired",
             "PHQ8_Appetite", "PHQ8_Failure", "PHQ8_Concentrating", "PHQ8_Moving"]

labels_by_id = {}
for split_file in base.glob("*split*.csv"):
    with split_file.open(newline="") as f:
        for row in csv.DictReader(f):
            pid = (row.get("Participant_ID") or row.get("participant_ID") or "").strip()
            score = row.get("PHQ8_Score") or row.get("PHQ_Score")
            if pid and score not in (None, ""):
                items = [int(row[c]) for c in ITEM_COLS if row.get(c) not in (None, "")]
                labels_by_id[pid] = {"phq8_total": int(score),
                                     "phq8_items": items if len(items) == 8 else None}

out = ROOT / "data" / "sources" / "daic_woz.jsonl"
out.parent.mkdir(parents=True, exist_ok=True)
n = 0
with out.open("w", encoding="utf-8") as f:
    for tf in sorted(base.rglob("*_TRANSCRIPT.csv")):
        pid = tf.name.split("_")[0]
        if pid not in labels_by_id:
            continue
        turns = []
        with tf.open(newline="", encoding="utf-8", errors="replace") as fh:
            for row in csv.DictReader(fh, delimiter="\t"):
                speaker = (row.get("speaker") or "").strip().lower()
                text = (row.get("value") or "").strip()
                if not text:
                    continue
                role = "bot" if speaker == "ellie" else "patient"
                if turns and turns[-1]["role"] == role:
                    turns[-1]["text"] += " " + text        # merge consecutive lines
                else:
                    turns.append({"role": role, "text": text})
        lab = labels_by_id[pid]
        labels = score_labels(phq8_total=lab["phq8_total"])
        labels["phq8_items"] = lab["phq8_items"]
        rec = make_record(
            id=f"daic-{pid}", source="DAIC-WOZ", license="USC ICT academic non-commercial",
            commercial_ok=False, synthetic=False, language="en", group_id=f"daic-{pid}",
            task="screening", turns=turns, labels=labels,
            meta={"note": "Self-reported PHQ-8; interviewer prompts leak labels, consider "
                          "training on patient turns only"},
        )
        if not validate(rec):
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            n += 1
print(f"wrote {n} DAIC-WOZ records to {out} (commercial_ok=False)")
