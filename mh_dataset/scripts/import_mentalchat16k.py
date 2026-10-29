"""Download MentalChat16K (MIT license) from Hugging Face and convert it.

It has NO screening labels: these records teach the bot a supportive tone
(task = "supportive_response"), not detection.

    pip install datasets
    python scripts/import_mentalchat16k.py
"""
import json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from mhds.schema import make_record, score_labels, validate

try:
    from datasets import load_dataset
except ImportError:
    sys.exit("Run: pip install datasets")

ds = load_dataset("ShenLab/MentalChat16K", split="train")
out = ROOT / "data" / "sources" / "mentalchat16k.jsonl"
out.parent.mkdir(parents=True, exist_ok=True)

n = skipped = 0
with out.open("w", encoding="utf-8") as f:
    for i, row in enumerate(ds):
        question = (row.get("input") or "").strip()
        answer = (row.get("output") or "").strip()
        if not question or not answer:
            skipped += 1
            continue
        rec = make_record(
            id=f"mc16k-{i}", source="MentalChat16K", license="MIT", commercial_ok=True,
            # Mix of AI-paraphrased real transcripts and GPT-3.5 synthetic rows
            synthetic=True, language="en", group_id=f"mc16k-{i}",
            task="supportive_response",
            turns=[{"role": "patient", "text": question}, {"role": "bot", "text": answer}],
            labels=score_labels(),
            meta={"system_instruction": row.get("instruction")},
        )
        if validate(rec):
            skipped += 1
            continue
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        n += 1
print(f"wrote {n} records to {out} (skipped {skipped})")
