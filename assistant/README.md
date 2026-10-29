# auzy-risk: the safety checks behind Auzy AI v2

A small Python service that the API (`../auzy-ai-v2`) calls for every patient message. It runs locally: no cost per
message, about 30 ms on a CPU.

```
POST /assess  {"text": "..."}   -> {"phrase": {"category", "language", "match"} | null,
                                    "model": {"risk", "risk_score", "state"}, "model_kind": "xlmr" | "tfidf"}
GET  /health
```

1. **Crisis phrases** (`safety.py`):
   - Categories: suicidal thoughts, self-harm, harming others, abuse.
   - Languages: English, French, Arabic and Tunisian Derja. Arabizi is normalised first (7→h, 9→q, 3→a, 5→kh…).
   - A match escalates the conversation at once.
2. **Risk model** (`risk_model.py`): XLM-RoBERTa base, fine-tuned on 8 states (normal, anxiety, depression, suicidal,
   self-harm, trauma, stress, loneliness/grief).
   - Risk = p(suicidal) + p(self-harm) above the threshold, which is capped at 0.5.
   - A model flag alone never alerts anyone. The API asks Sonnet for a second opinion on that message, and only
     Sonnet's confirmation escalates.
   - Long messages are read in pieces of about 350 characters, up to the 8,000-character limit; the riskiest piece counts.
   - `RISK_MODEL=tfidf` switches to a 10 MB model for small servers; it is weaker on indirect wording and Arabic/Derja.

**No authentication: keep it on the internal network.**

**Run:**
- Docker: `../docker-compose.yml` builds `Dockerfile.risk` (about 1.5 GB of RAM with XLM-R).
- Without Docker, from the package root: `python -m uvicorn assistant.risk_server:app --host 0.0.0.0 --port 8001`.

**Model location:** the models are shipped separately (`auzy-risk-model-xlmr.zip`). Unzip it into `models/`, so that
`models/risk-xlmr/model.safetensors` and `models/risk-tfidf.joblib` exist.

**Tests** (from the package root):
- `python -m assistant.test_risk_server`: 8 tests, needs the model.
- `python assistant/test_safety.py`: the crisis phrases.

## How good the model is (`models/REPORT_xlmr.md`)

| Test set | Risk recall | Risk precision |
|---|---|---|
| Real messages (586) | 0.984 | 0.884 |
| Synthetic messages (1,319; en/fr/ar) | 0.981 | 0.975 |

**Weak spot: Derja.** The model missed "Nheb nmout, ma3adech najjem" ("I want to die, I can't take it anymore") and
one of the four held-out Derja conversations. The crisis phrases catch explicit Derja wording like this example, so it
still escalates. Indirect Derja wording depends on the model and on Claude's own risk tag.

**Fix for the Derja weak spot:**
1. Native speakers review the 400 messages in `assistant/data/derja_review_sample.csv`.
2. Import their review with `python assistant/derja_review.py import assistant/data/derja_review_sample.csv`.
3. Retrain the model.

**Other limit:** some formal Arabic gets false alarms. These cost a Sonnet second opinion, never an alert.

## Training pipeline

| Step | Command (from the package root) | Output |
|---|---|---|
| Dataset of real and weak-labelled messages, 4 states | `mh_dataset/scripts/` (see `mh_dataset/README.md`) | `mh_dataset/data/combined/{train,validation,test}.csv` |
| Synthetic messages, 8 states, en/fr/ar/aeb (Claude Haiku, Batch API: **costs money**, budget ledger in `data/spend.json`) | `python assistant/generate_labelled.py --per-pair N` | `data/labelled_messages.jsonl` (13,182 checked), `data/derja_review.csv` |
| Derja review by native speakers | `python assistant/derja_review.py sample`, then `import <csv>` | `data/derja_reviewed.jsonl` (used by the next training run) |
| Train XLM-R (GPU recommended) | `python assistant/train_risk_model.py --model xlmr` | `models/risk-xlmr/`, `models/REPORT_xlmr.md` |
| Train the fallback | `python assistant/train_risk_model.py --model tfidf` | `models/risk-tfidf.joblib` |
| Re-evaluate only | `python assistant/train_risk_model.py --model xlmr --eval-only` | the report |

Python packages: `requirements.txt`. On a CUDA GPU, install torch from https://download.pytorch.org/whl/cu126.
`mh_dataset/data/external/` (51 MB of downloaded public datasets) is not included. The import scripts download it
again if you rebuild the dataset from scratch.
