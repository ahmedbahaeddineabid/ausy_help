"""Download openly licensed public datasets into data/external/ as JSONL.

    pip install datasets
    python scripts/import_public.py

Each dataset is saved as data/external/<name>_<split>.jsonl. A dataset whose card
does not state a license is skipped: check it by hand before adding it.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "external"

# (hub id, config, file stem, expected license)
SOURCES = [
    ("google-research-datasets/go_emotions", "simplified", "go_emotions", "apache-2.0"),
    ("ShenLab/MentalChat16K", None, "mentalchat16k", "mit"),
    ("nbertagnolli/counsel-chat", None, "counsel_chat", None),
]


def card_license(repo: str) -> str | None:
    from huggingface_hub import HfApi
    try:
        info = HfApi().dataset_info(repo)
        return (info.card_data or {}).get("license") if info.card_data else None
    except Exception:
        return None


def main():
    from datasets import load_dataset
    OUT.mkdir(parents=True, exist_ok=True)
    for repo, cfg, stem, expected in SOURCES:
        lic = card_license(repo)
        lic = lic if isinstance(lic, str) or lic is None else ",".join(lic)
        if not lic:
            print(f"SKIP {repo}: no license on its dataset card; check it by hand")
            continue
        if expected and lic.lower() != expected:
            print(f"NOTE {repo}: card says {lic!r}, expected {expected!r}")
        try:
            d = load_dataset(repo, cfg)
        except Exception as e:
            print(f"FAIL {repo}: {type(e).__name__}: {str(e)[:200]}", file=sys.stderr)
            continue
        for split, ds in d.items():
            ds.to_json(OUT / f"{stem}_{split}.jsonl", force_ascii=False)
        cols = list(next(iter(d.values())).features)
        print(f"OK   {repo} [{lic}] {({k: len(v) for k, v in d.items()})} columns={cols}")


if __name__ == "__main__":
    main()
