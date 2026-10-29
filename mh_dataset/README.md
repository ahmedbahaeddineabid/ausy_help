# Mental-health screening dataset (prototype)

A single dataset format and pipeline for training a model that estimates **PHQ-9**
(depression), **GAD-7** (anxiety) and **suicide-risk** labels from a patient–chatbot
conversation, in **English, French, Modern Standard Arabic and Tunisian Derja**.

It is a **screening** dataset: the labels are questionnaire scores, not diagnoses.

## What's inside

| Source | Records | License | In the default build? | Role |
|---|---|---|---|---|
| `seed` (hand-written) | 16 (4 per language) | Yours | Yes | Gold examples and style reference for the generator |
| `synthetic-llm` (you generate) | as many as you want | Yours; check your LLM provider's terms | Yes | Main training data for detection |
| `MentalChat16K` | ~16k | MIT | Yes | Supportive tone only: no screening labels |
| `DAIC-WOZ` | 189 | USC academic, non-commercial | **No** | Research benchmark only, under your own signed agreement |

These sources were researched but are **not** included:
- **Research-only clinical sets** (E-DAIC, D4, CMDC, eRisk, CARMA, UMD Suicidality, ESConv and others) need a signed agreement and forbid redistribution or commercial use.
- **Reddit and X datasets** are blocked by the platforms' terms, and their labels are proxies.

## Record format

Each line of a `.jsonl` file is one conversation:

```json
{
  "id": "seed-fr-B", "source": "seed", "license": "...", "commercial_ok": true,
  "synthetic": true, "language": "fr", "dialect": null, "group_id": "seed-fr-B",
  "task": "screening",
  "turns": [{"role": "bot", "text": "..."}, {"role": "patient", "text": "..."}],
  "labels": {
    "phq9_items": [2,2,2,2,1,1,2,1,0], "phq9_total": 13, "phq9_severity": "moderate",
    "gad7_items": [1,1,1,1,0,1,0], "gad7_total": 5, "gad7_severity": "mild",
    "phq8_total": 13, "suicide_risk": "none", "needs_human_review": false
  },
  "meta": {"persona": {...}, "profile_type": "moderate_depression"}
}
```

**Item scores** use the standard 0–3 scale: 0 = not at all, 1 = several days, 2 = more than half the days, 3 = nearly every day.

**Severity bands:**

| Questionnaire | Score ranges |
|---|---|
| PHQ-9 | 0–4 minimal, 5–9 mild, 10–14 moderate, 15–19 moderately severe, 20–27 severe |
| GAD-7 | 0–4 minimal, 5–9 mild, 10–14 moderate, 15–21 severe |

**`suicide_risk`** is one of `none`, `passive_ideation`, `active_ideation` or `plan_or_intent`. A PHQ-9 item 9 score above 0 always sets risk above `none`.

**`language`** codes: `en`, `fr`, `ar` (Modern Standard Arabic), `aeb` (Tunisian Derja in Latin script).

## How to build it

```bash
pip install -r requirements.txt

# 1. Seed conversations (already in data/sources/seed.jsonl)
python scripts/import_seed.py

# 2. Synthetic conversations: the bulk of your training data
export ANTHROPIC_API_KEY=...
python scripts/generate_synthetic.py --dry-run                  # inspect a prompt first
python scripts/generate_synthetic.py --n 2000 --languages en fr ar aeb

# 3. Optional: supportive-tone data
python scripts/import_mentalchat16k.py

# 4. Optional, research only: DAIC-WOZ after USC grants access
python scripts/import_daic_woz.py /path/to/daic_woz

# 5. Merge, validate, split
python scripts/build_dataset.py                                 # commercial-safe only
python scripts/build_dataset.py --include-noncommercial --out data/build_research
```

The build writes these files to `data/build/`:

| File | Contents |
|---|---|
| `train.jsonl`, `validation.jsonl`, `test.jsonl` | Full conversations |
| `*_classifier.jsonl` | Patient text only, with labels |
| `BUILD_SUMMARY.md` | Counts by source, language, severity and risk |

The classifier files contain only the patient's text on purpose. DAIC-WOZ research showed that models can "cheat" by reading the interviewer's questions.

## How the synthetic generator keeps labels honest

1. **Sample a profile first.** Each profile has item-level PHQ-9 and GAD-7 scores, a risk level, a persona and a talking style. Seven profile types run from minimal to active ideation without a plan.
2. **Write the dialogue from the profile.** The model writes a conversation that expresses exactly those scores, in the target language, using the seed conversation as a style reference.
3. **Re-score it blind.** A second call scores the transcript as a clinician would, without seeing the target labels. The dialogue is rejected if either total differs by more than 2 (`--tolerance`), or if the two scores disagree on whether item 9 shows any risk.
4. **Every risk case includes the bot escalating to a human.** The dialogues never describe self-harm methods.

## Before you rely on it

- **Native-speaker review:** the Derja and Arabic seed conversations need review by native-speaker clinicians. Derja spelling varies a lot; adjust the seed to match how your patients actually write.
- **Synthetic patients are too articulate.** Published evaluations (PSI-Bench, 2026) found simulated patients are more polished and less varied than real ones. Use synthetic data to train. Measure the model on real, consented conversations labelled by clinicians, not on synthetic test sets.
- **`plan_or_intent` is never generated.** These high-risk cases should be handled by fixed rules that escalate to a human, not learned only from synthetic data.
- **Seed-only builds put everything in `train`.** With only the seed, each language and severity group has a single conversation, so `validation` and `test` stay empty. Splits fill once you generate more data.
- **Moving to real users:** once the prototype talks to real patients, consent and data-protection rules apply, including INPDP authorization in Tunisia.
