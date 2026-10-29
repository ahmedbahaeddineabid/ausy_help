"""Convert the hand-written seed conversations into the unified format.

    python scripts/import_seed.py
"""
import json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from mhds.schema import make_record, score_labels, validate

src = ROOT / "seed" / "seed_conversations.json"
out = ROOT / "data" / "sources" / "seed.jsonl"
out.parent.mkdir(parents=True, exist_ok=True)

n = 0
with out.open("w", encoding="utf-8") as f:
    for c in json.loads(src.read_text(encoding="utf-8")):
        rec = make_record(
            id=c["id"], source="seed", license="proprietary (yours)", commercial_ok=True,
            synthetic=True, language=c["language"], dialect=c["dialect"], group_id=c["id"],
            task="screening", turns=c["turns"],
            labels=score_labels(c["phq9_items"], c["gad7_items"], c["suicide_risk"]),
            meta={"persona": c["persona"], "profile_type": c["profile_type"],
                  "generator": "hand-written"},
        )
        errs = validate(rec)
        if errs:
            sys.exit(f"{c['id']}: {errs}")
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        n += 1
print(f"wrote {n} seed records to {out}")
