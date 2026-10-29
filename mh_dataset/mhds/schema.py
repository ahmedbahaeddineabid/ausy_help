"""Unified record format, scoring and validation for the mental-health screening dataset.

Every source (seed, synthetic, MentalChat16K, DAIC-WOZ...) is converted to this one format,
so a model sees the same structure whatever the origin.
"""
from __future__ import annotations

ROLES = {"bot", "patient"}
LANGUAGES = {"en", "fr", "ar", "aeb"}          # aeb = Tunisian Arabic (Derja)
RISK_LEVELS = ["none", "passive_ideation", "active_ideation", "plan_or_intent"]
TASKS = {"screening", "supportive_response"}

PHQ9_ITEMS = [
    "little interest or pleasure", "feeling down or hopeless", "sleep problems",
    "tired or little energy", "appetite change", "feeling bad about yourself",
    "trouble concentrating", "moving/speaking slowly or restless",
    "thoughts of being better off dead or self-harm",
]
GAD7_ITEMS = [
    "nervous, anxious or on edge", "cannot stop or control worrying",
    "worrying too much about different things", "trouble relaxing",
    "so restless it is hard to sit still", "easily annoyed or irritable",
    "afraid something awful might happen",
]
# 0 = not at all, 1 = several days, 2 = more than half the days, 3 = nearly every day
FREQUENCY = ["not at all", "several days", "more than half the days", "nearly every day"]


def phq9_severity(total: int) -> str:
    if total <= 4: return "minimal"
    if total <= 9: return "mild"
    if total <= 14: return "moderate"
    if total <= 19: return "moderately_severe"
    return "severe"


def gad7_severity(total: int) -> str:
    if total <= 4: return "minimal"
    if total <= 9: return "mild"
    if total <= 14: return "moderate"
    return "severe"


def score_labels(phq9_items=None, gad7_items=None, suicide_risk=None, phq8_total=None) -> dict:
    """Build the labels block, computing totals and bands from item scores."""
    labels = {
        "phq9_items": phq9_items, "phq9_total": None, "phq9_severity": None,
        "gad7_items": gad7_items, "gad7_total": None, "gad7_severity": None,
        "phq8_total": phq8_total,
        "suicide_risk": suicide_risk,
    }
    if phq9_items is not None:
        labels["phq9_total"] = sum(phq9_items)
        labels["phq9_severity"] = phq9_severity(labels["phq9_total"])
        labels["phq8_total"] = sum(phq9_items[:8])
        # PHQ-9 item 9 above zero always means some level of risk
        if phq9_items[8] > 0 and suicide_risk in (None, "none"):
            labels["suicide_risk"] = "passive_ideation"
    if gad7_items is not None:
        labels["gad7_total"] = sum(gad7_items)
        labels["gad7_severity"] = gad7_severity(labels["gad7_total"])
    labels["needs_human_review"] = labels["suicide_risk"] not in (None, "none")
    return labels


def validate(rec: dict) -> list[str]:
    """Return a list of problems; empty list means the record is valid."""
    errs = []
    for key in ("id", "source", "license", "commercial_ok", "synthetic", "language",
                "group_id", "task", "turns", "labels"):
        if key not in rec:
            errs.append(f"missing field {key}")
    if errs:
        return errs
    if rec["language"] not in LANGUAGES:
        errs.append(f"unknown language {rec['language']}")
    if rec["task"] not in TASKS:
        errs.append(f"unknown task {rec['task']}")
    turns = rec["turns"]
    if not turns:
        errs.append("no turns")
    for i, t in enumerate(turns):
        if t.get("role") not in ROLES:
            errs.append(f"turn {i}: bad role {t.get('role')}")
        if not str(t.get("text", "")).strip():
            errs.append(f"turn {i}: empty text")
    lab = rec["labels"]
    p, g = lab.get("phq9_items"), lab.get("gad7_items")
    if p is not None and (len(p) != 9 or any(x not in (0, 1, 2, 3) for x in p)):
        errs.append("phq9_items must be 9 integers in 0-3")
    if g is not None and (len(g) != 7 or any(x not in (0, 1, 2, 3) for x in g)):
        errs.append("gad7_items must be 7 integers in 0-3")
    if lab.get("suicide_risk") not in (None, *RISK_LEVELS):
        errs.append(f"bad suicide_risk {lab.get('suicide_risk')}")
    if errs:
        return errs
    if p is not None and p[8] > 0 and lab.get("suicide_risk") == "none":
        errs.append("phq9 item 9 > 0 but suicide_risk is none")
    if rec["task"] == "screening" and lab.get("suicide_risk") not in (None, "none"):
        last_bot = " ".join(t["text"] for t in turns if t["role"] == "bot")
        if len(last_bot) < 50:
            errs.append("risk case without bot escalation text")
    return errs


def make_record(*, id, source, license, commercial_ok, synthetic, language, group_id,
                task, turns, labels, dialect=None, meta=None) -> dict:
    return {
        "id": id, "source": source, "license": license, "commercial_ok": commercial_ok,
        "synthetic": synthetic, "language": language, "dialect": dialect,
        "group_id": group_id, "task": task, "turns": turns, "labels": labels,
        "meta": meta or {},
    }
