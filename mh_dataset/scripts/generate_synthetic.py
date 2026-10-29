"""Generate labelled synthetic screening conversations with an LLM.

Each conversation is written FROM its labels: we first sample a patient profile with
item-level PHQ-9 and GAD-7 scores, then ask the model to write a dialogue that expresses
exactly those scores. A second "auditor" call re-scores the transcript blind; dialogues
whose audit disagrees with the target labels are rejected.

    pip install anthropic
    export ANTHROPIC_API_KEY=...
    python scripts/generate_synthetic.py --n 500 --languages en fr ar aeb
    python scripts/generate_synthetic.py --dry-run        # print one prompt, no API call

Output: data/sources/synthetic.jsonl (appends; safe to re-run).
"""
from __future__ import annotations
import argparse, json, random, re, sys, threading, time, uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from mhds.schema import (FREQUENCY, GAD7_ITEMS, PHQ9_ITEMS, make_record, score_labels,
                         validate)

LANG_NAMES = {
    "en": "English",
    "fr": "French",
    "ar": "Modern Standard Arabic (Arabic script)",
    "aeb": "Tunisian Arabic (Derja) written in Latin script with numerals (3=ع, 7=ح, 9=ق), "
           "with natural French code-switching",
}
OCCUPATIONS = {
    "en": ["nurse", "student", "teacher", "driver", "shop owner", "engineer", "retired",
           "unemployed", "cleaner", "call-centre agent", "farmer", "homemaker"],
    "fr": ["infirmière", "étudiant", "enseignante", "chauffeur", "commerçant", "ingénieure",
           "retraité", "sans emploi", "agent d'entretien", "téléconseillère", "agriculteur",
           "mère au foyer"],
    "ar": ["ممرضة", "طالب", "معلمة", "سائق", "صاحب متجر", "مهندسة", "متقاعد", "عاطل عن العمل",
           "عامل نظافة", "موظفة مركز اتصال", "فلاح", "ربة بيت"],
    "aeb": ["infirmière", "étudiant", "prof", "chauffeur louage", "3attar", "ingénieure",
            "retraité", "bettal", "femme de ménage", "call center", "fallah", "mra fi dar"],
}
STRESSORS = ["exams", "job loss", "bereavement", "chronic illness", "money problems",
             "marital conflict", "caring for a sick parent", "migration of a family member",
             "new baby", "work overload", "loneliness", "no particular stressor"]

# Target bands (PHQ-9 range, GAD-7 range, risk level) and how often to sample them.
PROFILES = {
    "minimal":                     ((0, 4),   (0, 4),   "none",             0.20),
    "mild_mixed":                  ((5, 9),   (5, 9),   "none",             0.20),
    "moderate_depression":         ((10, 14), (0, 9),   "none",             0.15),
    "moderately_severe_depression":((15, 19), (5, 14),  "none",             0.10),
    "anxiety_dominant":            ((0, 9),   (10, 21), "none",             0.15),
    "severe_passive_ideation":     ((15, 27), (5, 21),  "passive_ideation", 0.12),
    "active_ideation_no_plan":     ((15, 27), (5, 21),  "active_ideation",  0.08),
}


def sample_items(n_items: int, lo: int, hi: int, rng: random.Random, fixed: dict | None = None):
    """Random item scores (0-3) whose total falls in [lo, hi]; `fixed` pins some items."""
    fixed = fixed or {}
    free = [i for i in range(n_items) if i not in fixed]
    base = sum(fixed.values())
    target = min(max(rng.randint(lo, hi), base), base + 3 * len(free))
    items = [fixed.get(i, rng.randint(0, 3)) for i in range(n_items)]
    while sum(items) != target:
        i = rng.choice(free)
        if sum(items) < target and items[i] < 3:
            items[i] += 1
        elif sum(items) > target and items[i] > 0:
            items[i] -= 1
    return items


def sample_profile(rng: random.Random, languages: list[str]) -> dict:
    names = list(PROFILES)
    ptype = rng.choices(names, weights=[PROFILES[k][3] for k in names])[0]
    (plo, phi), (glo, ghi), risk, _ = PROFILES[ptype]
    if risk == "none":
        phq = sample_items(9, plo, phi, rng, fixed={8: 0})
    elif risk == "passive_ideation":
        phq = sample_items(9, plo, phi, rng, fixed={8: rng.choice([1, 1, 2])})
    else:
        phq = sample_items(9, plo, phi, rng, fixed={8: rng.choice([2, 3])})
    gad = sample_items(7, glo, ghi, rng)
    lang = rng.choice(languages)
    return {
        "profile_type": ptype, "language": lang, "phq9_items": phq, "gad7_items": gad,
        "suicide_risk": risk,
        "persona": {"age": rng.randint(18, 75), "gender": rng.choice(["female", "male"]),
                    "occupation": rng.choice(OCCUPATIONS[lang]),
                    "stressor": rng.choice(STRESSORS),
                    "talk_style": rng.choice(["brief and guarded", "talkative", "vague, minimises",
                                              "emotional", "matter-of-fact",
                                              "denies at first, discloses when asked again"])},
    }


def seed_example(lang: str) -> str:
    seeds = json.loads((ROOT / "seed" / "seed_conversations.json").read_text(encoding="utf-8"))
    ex = next(s for s in seeds if s["language"] == lang and s["profile_type"] == "moderate_depression")
    return json.dumps({"turns": ex["turns"]}, ensure_ascii=False)


def generation_system(lang_code: str) -> list[dict]:
    """Fixed per language, so it is cached and shared by every request in that language."""
    text = f"""You write realistic, clinically accurate training data for a mental-health SCREENING \
chatbot used under clinician supervision. You write both sides of the dialogue. \
The data trains a model to estimate PHQ-9 and GAD-7 item scores from conversation, so \
the patient's words must support exactly the target score for every item.

Every conversation is in {LANG_NAMES[lang_code]} and covers the last two weeks.

Rules:
- The bot opens by saying this is a screening, not a diagnosis, and covers every PHQ-9 and
  GAD-7 domain conversationally (not reading the questionnaire), in any natural order.
- The bot asks EVERY patient about thoughts of death or self-harm.
- The patient's answers must make each item's frequency inferable, but express it the way
  real people do (examples, "most mornings", "only once or twice"), not by quoting the scale.
  Match the talk style; it is fine for the bot to ask a short follow-up to clarify.
- Follow the risk rule given with each patient exactly.
- No description of self-harm methods, ever.
- The bot closes with a short summary of severity, says it is not a diagnosis, and gives
  a next step proportional to severity.
- 16 to 30 turns. Do not mention scores or questionnaire names in the dialogue.

Style reference (different patient, same language):
{seed_example(lang_code)}

Return ONLY JSON: {{"turns": [{{"role": "bot"|"patient", "text": "..."}}, ...]}}"""
    return [{"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}]


def generation_prompt(p: dict) -> tuple[list[dict], str]:
    phq = "\n".join(f"  {i+1}. {name}: {p['phq9_items'][i]} ({FREQUENCY[p['phq9_items'][i]]})"
                    for i, name in enumerate(PHQ9_ITEMS))
    gad = "\n".join(f"  {i+1}. {name}: {p['gad7_items'][i]} ({FREQUENCY[p['gad7_items'][i]]})"
                    for i, name in enumerate(GAD7_ITEMS))
    risk_rules = {
        "none": "The patient clearly denies any thoughts of death or self-harm when asked.",
        "passive_ideation": "When asked, the patient discloses passive thoughts (e.g. it would be "
            "easier not to wake up) with no intent or plan. The bot thanks them, asks directly "
            "about intent or a plan (the patient says no), says it is alerting the care team "
            "for same-day contact, gives emergency guidance, and asks who is with them.",
        "active_ideation": "When asked, the patient discloses thoughts of ending their life but "
            "no specific plan or intent to act. The bot responds calmly, asks about plan and "
            "intent (none), says a clinician will contact them urgently today, gives emergency "
            "guidance, asks about safety and who is with them.",
    }[p["suicide_risk"]]
    user = f"""Write one screening conversation.

Patient: {json.dumps(p['persona'], ensure_ascii=False)}

Target PHQ-9 item scores (0-3):
{phq}
Target GAD-7 item scores (0-3):
{gad}

Risk rule: {risk_rules}"""
    return generation_system(p["language"]), user


def audit_prompt(turns: list[dict]) -> tuple[str, str]:
    transcript = "\n".join(f"{t['role'].upper()}: {t['text']}" for t in turns)
    system = ("You are a clinician scoring a screening conversation. Score only what the "
              "patient actually said.")
    user = f"""Score this conversation for the last two weeks.
PHQ-9 items: {PHQ9_ITEMS}
GAD-7 items: {GAD7_ITEMS}
Scale: 0 not at all, 1 several days, 2 more than half the days, 3 nearly every day.

{transcript}

Return ONLY JSON: {{"phq9_items": [9 ints], "gad7_items": [7 ints]}}"""
    return system, user


# USD per million tokens (claude-sonnet-5-5). Batch halves every rate.
PRICES = {"input": 2.00, "output": 10.00, "cache_write": 2.50, "cache_read": 0.20}
MAX_CONSECUTIVE_FAILURES = 10
GEN_TOKENS, AUDIT_TOKENS = 8000, 2000


class Ledger:
    """Thread-safe token and cost tally."""

    def __init__(self):
        self.lock = threading.Lock()
        self.tokens = {"input": 0, "output": 0, "cache_write": 0, "cache_read": 0}
        self.cost = 0.0
        self.truncated = 0

    def add(self, msg, batch: bool = False):
        u = msg.usage
        t = {"input": u.input_tokens, "output": u.output_tokens,
             "cache_write": u.cache_creation_input_tokens or 0,
             "cache_read": u.cache_read_input_tokens or 0}
        with self.lock:
            for k, v in t.items():
                self.tokens[k] += v
                self.cost += v * PRICES[k] / 1e6 * (0.5 if batch else 1.0)
            if msg.stop_reason == "max_tokens":
                self.truncated += 1

    def report(self, accepted: int) -> str:
        per = self.cost / accepted if accepted else float("nan")
        return (f"tokens {self.tokens}  truncated {self.truncated}  "
                f"cost ${self.cost:.2f}  per accepted ${per:.4f}")


def request_params(args, model: str, system, user: str, max_tokens: int) -> dict:
    return {"model": model, "max_tokens": max_tokens, "system": system,
            "output_config": {"effort": args.effort},
            "messages": [{"role": "user", "content": user}]}


def gen_params(args, profile: dict) -> dict:
    return request_params(args, args.model, *generation_prompt(profile), GEN_TOKENS)


def audit_params(args, turns: list[dict]) -> dict:
    return request_params(args, args.audit_model, *audit_prompt(turns), AUDIT_TOKENS)


def parse_json(msg) -> dict:
    if msg.stop_reason == "refusal":
        raise ValueError("refused")
    text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ValueError(f"no JSON in response (stop_reason={msg.stop_reason})")
    return json.loads(m.group(0))


def call(client, ledger: Ledger, params: dict) -> dict:
    msg = client.messages.create(**params)
    ledger.add(msg)
    return parse_json(msg)


def audit_ok(target: dict, audited: dict, tol: int) -> bool:
    tp, tg = target["phq9_items"], target["gad7_items"]
    ap, ag = audited["phq9_items"], audited["gad7_items"]
    if len(ap) != 9 or len(ag) != 7:
        return False
    if (tp[8] > 0) != (ap[8] > 0):                    # risk item must agree exactly
        return False
    return abs(sum(tp) - sum(ap)) <= tol and abs(sum(tg) - sum(ag)) <= tol


def build_record(args, profile: dict, turns: list[dict], audited: dict | None) -> dict | None:
    rid = f"syn-{profile['language']}-{uuid.uuid4().hex[:10]}"
    rec = make_record(
        id=rid, source="synthetic-llm", license="proprietary (yours); check your LLM provider terms",
        commercial_ok=True, synthetic=True, language=profile["language"],
        dialect="tunisian_derja_latin" if profile["language"] == "aeb" else
                ("msa" if profile["language"] == "ar" else None),
        group_id=rid, task="screening", turns=turns,
        labels=score_labels(profile["phq9_items"], profile["gad7_items"], profile["suicide_risk"]),
        meta={"persona": profile["persona"], "profile_type": profile["profile_type"],
              "generator": args.model, "effort": args.effort, "audit": audited,
              "clinician_reviewed": False},
    )
    return None if validate(rec) else rec


def make_one(client, args, ledger: Ledger, profile: dict) -> dict | None:
    turns = call(client, ledger, gen_params(args, profile))["turns"]
    audited = None
    if not args.no_audit:
        audited = call(client, ledger, audit_params(args, turns))
        if not audit_ok(profile, audited, args.tolerance):
            return None
    return build_record(args, profile, turns, audited)


def fatal(e: Exception) -> bool:
    """Errors that will fail every request: stop instead of paying for retries."""
    import anthropic
    return isinstance(e, (anthropic.AuthenticationError, anthropic.PermissionDeniedError,
                          anthropic.BadRequestError, anthropic.NotFoundError, TypeError))


def run_interactive(client, args, rng, out: Path, ledger: Ledger) -> int:
    accepted = rejected = failed = streak = 0
    with out.open("a", encoding="utf-8") as f, ThreadPoolExecutor(args.workers) as pool:
        while accepted < args.n:
            batch = [pool.submit(make_one, client, args, ledger, sample_profile(rng, args.languages))
                     for _ in range(min(args.workers * 2, args.n - accepted))]
            for fut in as_completed(batch):
                try:
                    rec = fut.result()
                    streak = 0
                except Exception as e:                       # network / JSON errors
                    failed += 1
                    streak += 1
                    print("error:", e, file=sys.stderr)
                    if fatal(e) or streak >= MAX_CONSECUTIVE_FAILURES:
                        pool.shutdown(cancel_futures=True)
                        sys.exit(f"aborting after {failed} errors. {ledger.report(accepted)}")
                    continue
                if rec is None:
                    rejected += 1
                    continue
                f.write(json.dumps(rec, ensure_ascii=False) + "\n"); f.flush()
                accepted += 1
            print(f"accepted {accepted}/{args.n}  rejected by audit {rejected}  errors {failed}  "
                  f"{ledger.report(accepted)}")
    return accepted


def run_batch_stage(client, ledger: Ledger, requests: dict, poll: int, label: str) -> dict:
    """Submit {custom_id: params}, wait, return {custom_id: parsed JSON} for those that parsed."""
    from anthropic.types.messages.batch_create_params import Request
    b = client.messages.batches.create(
        requests=[Request(custom_id=cid, params=p) for cid, p in requests.items()])
    print(f"{label}: submitted batch {b.id} with {len(requests)} requests")
    while (s := client.messages.batches.retrieve(b.id)).processing_status != "ended":
        print(f"{label}: {s.processing_status}, {s.request_counts.processing} processing")
        time.sleep(poll)
    c = s.request_counts
    print(f"{label}: ended, ok {c.succeeded} errored {c.errored} expired {c.expired}")
    results = {}
    for r in client.messages.batches.results(b.id):
        if r.result.type != "succeeded":
            continue
        ledger.add(r.result.message, batch=True)
        try:
            results[r.custom_id] = parse_json(r.result.message)
        except (ValueError, json.JSONDecodeError):
            pass
    return results


def run_batch(client, args, rng, out: Path, ledger: Ledger) -> int:
    """Batch API: half price, results within 24 h (usually under 1 h). Later rounds top up."""
    accepted = attempts = 0
    pass_rate = 0.7                                     # first-round guess, then measured
    while accepted < args.n:
        k = int((args.n - accepted) / max(pass_rate, 0.2) * 1.1) + 1
        profiles = {uuid.uuid4().hex: sample_profile(rng, args.languages) for _ in range(k)}
        gen = run_batch_stage(client, ledger, {cid: gen_params(args, p) for cid, p in profiles.items()},
                              args.poll, "generate")
        turns = {cid: g["turns"] for cid, g in gen.items() if isinstance(g.get("turns"), list)}
        audits = {} if args.no_audit else run_batch_stage(
            client, ledger, {cid: audit_params(args, t) for cid, t in turns.items()}, args.poll, "audit")

        new = 0
        with out.open("a", encoding="utf-8") as f:
            for cid, t in turns.items():
                audited = audits.get(cid)
                if not args.no_audit and (audited is None or
                                          not audit_ok(profiles[cid], audited, args.tolerance)):
                    continue
                rec = build_record(args, profiles[cid], t, audited)
                if rec and accepted < args.n:
                    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    accepted += 1
                    new += 1
        attempts += k
        if new == 0:
            sys.exit(f"round produced nothing; stopping. {ledger.report(accepted)}")
        pass_rate = accepted / attempts
        print(f"accepted {accepted}/{args.n}  pass rate {pass_rate:.0%}  {ledger.report(accepted)}")
    return accepted


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=100, help="accepted conversations to produce")
    ap.add_argument("--languages", nargs="+", default=["en", "fr", "ar", "aeb"])
    ap.add_argument("--model", default="claude-sonnet-5-5")
    ap.add_argument("--audit-model", default="claude-sonnet-5-5")
    ap.add_argument("--effort", default="medium", choices=["low", "medium", "high", "xhigh", "max"])
    ap.add_argument("--tolerance", type=int, default=2, help="max total-score gap in audit")
    ap.add_argument("--no-audit", action="store_true")
    ap.add_argument("--batch", action="store_true", help="use the Batch API (half price, async)")
    ap.add_argument("--poll", type=int, default=60, help="seconds between batch status checks")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--out", type=Path, default=ROOT / "data" / "sources" / "synthetic.jsonl")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    rng = random.Random(args.seed)
    if args.dry_run:
        p = sample_profile(rng, args.languages)
        s, u = generation_prompt(p)
        print("=== PROFILE ===\n", json.dumps(p, ensure_ascii=False, indent=1))
        print("=== SYSTEM (cached) ===\n", s[0]["text"], "\n=== USER ===\n", u)
        return

    args.out.parent.mkdir(parents=True, exist_ok=True)
    ledger = Ledger()
    import anthropic
    client = anthropic.Anthropic()
    accepted = (run_batch if args.batch else run_interactive)(client, args, rng, args.out, ledger)
    print(f"done -> {args.out}\n{ledger.report(accepted)}")


if __name__ == "__main__":
    main()
