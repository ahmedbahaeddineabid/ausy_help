"""Generate labelled patient messages for 8 mental states x 4 languages with Claude Haiku 5.5.

Two passes, each in the Batch API (half price) for full runs:
  1. generate  - each request writes N short messages for one (state, language, style)
  2. check     - a separate request labels the messages blind; only agreements are kept

Spending is tracked across runs in data/spend.json. Before any request is sent, the
worst case (max input + max output tokens on every request) is checked against --budget;
nothing is submitted that could take total spending over it.

    $env:ANTHROPIC_API_KEY = "..."           # in your own terminal
    python assistant/generate_labelled.py --test          # 4 small requests + check, < $0.01
    python assistant/generate_labelled.py --per-pair 1000 # full run, batch mode

Output: data/generated_raw.jsonl (everything), data/labelled_messages.jsonl (checked).
"""
from __future__ import annotations

import argparse
import itertools
import json
import random
import re
import sys
import time
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
SPEND = DATA / "spend.json"
MODEL = "claude-haiku-5-5"
# USD per million tokens for Claude Haiku 5.5 (prompts under 100K tokens). Batch halves both.
PRICE_IN, PRICE_OUT = 0.10, 0.50

STATES = {
    "normal": "everyday life with neutral or positive mood; ordinary hassles are fine, but no lasting "
              "distress and no clinical symptoms",
    "anxiety": "persistent worry or fear, nervousness, panic attacks, physical tension (racing heart, "
               "tight chest), expecting something bad to happen",
    "depression": "low mood most days, loss of interest or pleasure, hopelessness, exhaustion, sleep or "
                  "appetite changes, feeling worthless or guilty; NO thoughts of death",
    "suicidal": "thoughts of death or of ending one's life, from passive ('it would be easier not to wake "
                "up', 'everyone would be better off without me', 'I want to disappear') to an explicit "
                "wish to die. Never mention methods, means, plans or places",
    "self_harm": "hurting oneself on purpose to cope with emotions (may say 'I cut again', 'I hit myself', "
                 "'I hurt myself when it gets too much') WITHOUT wanting to die. Never describe how, "
                 "tools, or injuries",
    "trauma": "after a frightening or violent event (accident, assault, war, abuse, loss): flashbacks, "
              "nightmares, being constantly on edge, avoiding reminders, feeling unsafe",
    "stress": "pressure from work, study, money or caring for someone; overload, burnout, irritability, "
              "no time to rest, while interest in life is otherwise intact",
    "loneliness_grief": "feeling alone or isolated, having nobody to talk to, or mourning a person who "
                        "died or another loss",
}
LANGS = {
    "en": "English",
    "fr": "French",
    "ar": "Modern Standard Arabic (Arabic script)",
    "aeb": "Tunisian Arabic (Derja) written in Latin script with numerals (3=ع, 7=ح, 9=ق, 5=خ), with "
           "natural French code-switching, the way Tunisians text",
}
REVIEW_LANGS = {"aeb"}      # kept unfiltered and sent to data/derja_review.csv

STYLES = [
    "very short, under 12 words, like a first chat message",
    "one or two sentences",
    "three or four sentences with some personal context (job, family, studies)",
    "indirect: the person hints at how they feel rather than naming it",
    "informal texting with typos, missing punctuation and abbreviations",
    "a reply to a chatbot that just asked 'how have you been feeling lately?'",
]

GEN_SYSTEM = ("You write realistic training data for a classifier that detects mental states in "
              "messages patients send to a mental-health support chat run under clinician "
              "supervision. The classifier's main job is safety: when a message shows suicidal "
              "thoughts or self-harm, the conversation is escalated so a human clinician contacts the "
              "person the same day. Messages it fails to recognise are people who do not get that "
              "call, so it must learn the many indirect ways people express these states, in every "
              "language the service supports. The messages are used only to train and test this "
              "classifier and are never shown to patients. "
              "Messages must sound like real people of different ages, genders and backgrounds, not "
              "like textbook descriptions, and never name a diagnosis. Never include methods, means, "
              "plans or details of suicide or self-harm.")
CHECK_SYSTEM = ("You label messages sent to a mental-health support chat. Choose exactly one label per "
                "message from:\n" + "\n".join(f"- {k}: {v}" for k, v in STATES.items()) +
                "\nIf a message mentions any wish to die or not exist, the label is suicidal. If it "
                "mentions hurting oneself without wanting to die, the label is self_harm.")


def gen_prompt(state: str, lang: str, style: str, n: int, rng: random.Random) -> str:
    return (f"Write {n} different messages in {LANGS[lang]} from different people whose message "
            f"shows this state: {state} = {STATES[state]}.\n"
            f"Style: {style}.\n"
            f"Vary age, gender, situation and wording; no two messages may share an opening. "
            f"{'Use Tunisian names, places and daily life. ' if lang in ('ar', 'aeb') else ''}"
            f"Variation seed: {rng.randint(1000, 9999)}.\n"
            'Return ONLY JSON: {"messages": ["...", "..."]}')


def check_prompt(messages: list[str]) -> str:
    listing = "\n".join(f"{i + 1}. {m}" for i, m in enumerate(messages))
    return (f"Label each message.\n\n{listing}\n\n"
            f'Return ONLY JSON: {{"labels": [{len(messages)} labels, in order]}}')


def params(system: str, user: str, max_tokens: int) -> dict:
    return {"model": MODEL, "max_tokens": max_tokens, "system": system,
            "thinking": {"type": "disabled"}, "output_config": {"effort": "medium"},
            "messages": [{"role": "user", "content": user}]}


# ---------------------------------------------------------------- budget

def spent() -> float:
    return json.loads(SPEND.read_text())["usd"] if SPEND.exists() else 0.0


def add_spend(msg, batch: bool) -> float:
    cost = (msg.usage.input_tokens * PRICE_IN + msg.usage.output_tokens * PRICE_OUT) / 1e6
    cost *= 0.5 if batch else 1.0
    DATA.mkdir(parents=True, exist_ok=True)
    rec = json.loads(SPEND.read_text()) if SPEND.exists() else {"usd": 0.0, "requests": 0}
    rec["usd"] += cost
    rec["requests"] += 1
    SPEND.write_text(json.dumps(rec, indent=1))
    return cost


def worst_case(reqs: list[dict], batch: bool) -> float:
    """Upper bound: ~1 token per 2 characters of input (safe for Arabic) and full max_tokens out."""
    total = sum((len(p["system"]) + len(p["messages"][0]["content"])) / 2 * PRICE_IN
                + p["max_tokens"] * PRICE_OUT for p in reqs) / 1e6
    return total * (0.5 if batch else 1.0)


def guard(reqs: list[dict], batch: bool, budget: float, label: str):
    wc, already = worst_case(reqs, batch), spent()
    print(f"{label}: {len(reqs)} requests, worst case ${wc:.4f}; spent so far ${already:.4f}; "
          f"budget ${budget:.2f}")
    if already + wc > budget:
        sys.exit(f"STOP: {label} could take spending to ${already + wc:.2f}, over the ${budget:.2f} budget. "
                 f"Nothing was sent.")


# ---------------------------------------------------------------- calls

def parse_json(msg) -> dict:
    if msg.stop_reason == "refusal":
        raise ValueError("refused")
    text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ValueError(f"no JSON (stop_reason={msg.stop_reason})")
    return json.loads(m.group(0))


def run_direct(client, reqs: dict[str, dict]) -> dict[str, dict]:
    import anthropic
    out = {}
    for cid, p in reqs.items():
        try:
            msg = client.messages.create(**p)
        except (anthropic.AuthenticationError, anthropic.PermissionDeniedError) as e:
            sys.exit(f"STOP: the API rejected the key ({type(e).__name__}). Nothing was charged.")
        add_spend(msg, batch=False)
        try:
            out[cid] = parse_json(msg)
        except (ValueError, json.JSONDecodeError) as e:
            print(f"  {cid}: skipped ({e})")
    return out


def run_batch(client, reqs: dict[str, dict], poll: int, label: str) -> dict[str, dict]:
    from anthropic.types.messages.batch_create_params import Request
    b = client.messages.batches.create(requests=[Request(custom_id=c, params=p) for c, p in reqs.items()])
    print(f"{label}: batch {b.id} submitted ({len(reqs)} requests)")
    while (s := client.messages.batches.retrieve(b.id)).processing_status != "ended":
        print(f"{label}: {s.request_counts.processing} still processing")
        time.sleep(poll)
    out, skipped = {}, 0
    for r in client.messages.batches.results(b.id):
        if r.result.type != "succeeded":
            skipped += 1
            continue
        add_spend(r.result.message, batch=True)
        try:
            out[r.custom_id] = parse_json(r.result.message)
        except (ValueError, json.JSONDecodeError):
            skipped += 1
    print(f"{label}: {len(out)} usable, {skipped} skipped, total spent ${spent():.4f}")
    return out


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--test", action="store_true", help="one small direct request per --test-langs + check")
    ap.add_argument("--test-langs", nargs="+", default=list(LANGS), choices=list(LANGS))
    ap.add_argument("--test-state", default="suicidal", choices=list(STATES))
    ap.add_argument("--per-pair", type=int, default=1000, help="messages per (state, language) pair")
    ap.add_argument("--per-request", type=int, default=25)
    ap.add_argument("--tokens-per-message", type=int, default=120, help="output budget per message")
    ap.add_argument("--states", nargs="+", default=list(STATES), choices=list(STATES))
    ap.add_argument("--langs", nargs="+", default=list(LANGS), choices=list(LANGS))
    ap.add_argument("--budget", type=float, default=3.0, help="hard cap on total USD across all runs")
    ap.add_argument("--poll", type=int, default=60)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    rng = random.Random(args.seed)
    if args.test:
        jobs = [(args.test_state, l, STYLES[i % len(STYLES)], 10) for i, l in enumerate(args.test_langs)]
    else:
        per_req = args.per_request
        jobs = [(s, l, STYLES[i % len(STYLES)], per_req)
                for s, l in itertools.product(args.states, args.langs)
                for i in range(-(-args.per_pair // per_req))]
    meta = {uuid.uuid4().hex: j for j in jobs}
    # Arabic script and Derja take far more tokens per word than English: 60/message was cut off.
    gen_reqs = {cid: params(GEN_SYSTEM, gen_prompt(s, l, st, n, rng), args.tokens_per_message * n + 200)
                for cid, (s, l, st, n) in meta.items()}

    import anthropic
    client = anthropic.Anthropic()
    batch = not args.test
    guard(list(gen_reqs.values()), batch, args.budget, "generate")
    gen = run_batch(client, gen_reqs, args.poll, "generate") if batch else run_direct(client, gen_reqs)

    rows = []
    for cid, g in gen.items():
        s, l, st, _ = meta[cid]
        for m in g.get("messages", []):
            if isinstance(m, str) and len(m.strip()) >= 3:
                rows.append({"text": m.strip(), "target": s, "language": l, "style": st})
    DATA.mkdir(parents=True, exist_ok=True)
    with (DATA / "generated_raw.jsonl").open("a", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"generated {len(rows)} messages")

    # Blind check: shuffle so each request mixes states; the checker never sees the target.
    rng.shuffle(rows)
    chunk = 10 if args.test else args.per_request
    groups = {uuid.uuid4().hex: rows[i:i + chunk] for i in range(0, len(rows), chunk)}
    check_reqs = {cid: params(CHECK_SYSTEM, check_prompt([r["text"] for r in g]), 15 * len(g) + 100)
                  for cid, g in groups.items()}
    guard(list(check_reqs.values()), batch, args.budget, "check")
    checked = run_batch(client, check_reqs, args.poll, "check") if batch else run_direct(client, check_reqs)

    kept = []
    for cid, res in checked.items():
        labels = res.get("labels", [])
        if len(labels) != len(groups[cid]):
            continue
        for r, lab in zip(groups[cid], labels):
            r["checked_label"] = lab
            if lab == r["target"] and r["language"] not in REVIEW_LANGS:
                kept.append(r)

    # Haiku writes and checks Derja poorly: keep every Derja message for a native speaker to review
    # instead of trusting the check. Disagreements are listed first.
    review = [r for r in rows if r["language"] in REVIEW_LANGS]
    if review:
        import csv
        path = DATA / "derja_review.csv"
        new = not path.exists()
        with path.open("a", encoding="utf-8-sig", newline="") as f:
            w = csv.writer(f)
            if new:
                w.writerow(["text", "target", "checked_label", "check_agrees", "reviewer_label", "reviewer_ok"])
            for r in sorted(review, key=lambda r: r.get("checked_label") == r["target"]):
                w.writerow([r["text"], r["target"], r.get("checked_label", ""),
                            r.get("checked_label") == r["target"], "", ""])
        print(f"{len(review)} Derja messages added to {path} for native review")
    with (DATA / "labelled_messages.jsonl").open("a", encoding="utf-8") as f:
        for r in kept:
            f.write(json.dumps({"text": r["text"], "mental_state": r["target"], "language": r["language"],
                                "source": "synthetic-haiku", "label_quality": "synthetic"},
                               ensure_ascii=False) + "\n")
    print(f"kept {len(kept)}/{len(rows)} after the blind check; total spent ${spent():.4f} "
          f"of ${args.budget:.2f}")
    if args.test:
        print("\n--- samples (target -> blind label) ---")
        for r in sorted(rows, key=lambda r: (r["language"], r["target"])):
            print(f"[{r['language']}] {r['target']} -> {r.get('checked_label', '?')}: {r['text']}")


if __name__ == "__main__":
    main()
