"""Crisis-phrase checks, escalation hook and emergency text. No model, no cost, no network.

Patients mix languages (Derja with French, Arabic script with Latin), so every message is
checked against the phrase lists of ALL languages. The lists favour recall: "I don't want to
die" can still match, because a false alarm costs a stronger-model turn and a clinician's
glance, while a miss costs a person in crisis.

THE PHRASE LISTS AND EMERGENCY TEXTS MUST BE REVIEWED BY NATIVE-SPEAKER CLINICIANS
(especially Arabic and Derja) BEFORE ANY REAL PATIENT USES THIS.

    from assistant.safety import check, escalate, emergency_text
    hit = check("Nheb nmout, ma3adech najjem")
    # {'category': 'suicidal', 'language': 'aeb', 'pattern': '...'} or None

    python assistant/safety.py "message" ["message" ...]
    python assistant/safety.py --eval        # recall / false alarms on the labelled data
"""
from __future__ import annotations

import json
import os
import re
import time
import unicodedata
from pathlib import Path

HERE = Path(__file__).resolve().parent
ESCALATION_LOG = HERE / "data" / "escalations.jsonl"

# --------------------------------------------------------------------------- normalisation

_AR_DIACRITICS = re.compile(r"[ؐ-ًؚ-ٰٟۖ-ۭـ]")


def norm_latin(text: str) -> str:
    """Lowercase, strip accents (French), collapse whitespace."""
    t = unicodedata.normalize("NFKD", text.lower())
    t = "".join(c for c in t if not unicodedata.combining(c))
    t = t.replace("’", "'")
    return re.sub(r"\s+", " ", t)


def norm_arabic(text: str) -> str:
    t = _AR_DIACRITICS.sub("", text)
    t = re.sub("[إأآٱ]", "ا", t)
    return t.replace("ة", "ه").replace("ى", "ي").replace("ؤ", "و").replace("ئ", "ي")


def norm_derja(text: str) -> str:
    """Tunisian Arabizi: 7=h, 9=q, 5=kh, 3=a, 8=gh, 2=hamza; ou=u; ch=sh; doubled letters collapsed."""
    t = norm_latin(text)
    for a, b in (("7", "h"), ("9", "q"), ("5", "kh"), ("8", "gh"), ("3", "a"), ("2", ""),
                 ("'", ""), ("-", " "), ("ou", "u"), ("ch", "sh")):
        t = t.replace(a, b)
    return re.sub(r"([a-z])\1+", r"\1", t)


# --------------------------------------------------------------------------- phrase lists
# (category, pattern). Patterns run on the normalised text of the matching script.

EN = [
    ("suicidal", r"\bkill(ing)? my ?self\b|\bsuicid"),
    ("suicidal", r"\b(want|wanna|wanted|going|ready|plan(ning)?) (to )?die\b|\bwish i (was|were) dead\b"),
    ("suicidal", r"\bend(ing)? (it all|my life|everything|things)\b|\btake my (own )?life\b"),
    ("suicidal", r"\b(better off|be better) (dead|without me)\b|\bbetter off if i (was|were)n'?t (here|around|alive)\b"),
    ("suicidal", r"\b(don'?t|do not|no longer) want to (live|be alive|exist|be here|wake up)\b"),
    ("suicidal", r"\b(not|never) (to )?wake up\b|\bdidn'?t wake up\b|\bno reason to (live|go on|stay)\b"),
    ("suicidal", r"\bwish i (was|had) never (been )?born\b|\bcan'?t go on (living|anymore)\b"),
    ("suicidal", r"\b(disappear|stop existing) (forever|for good)\b|\bnot be here anymore\b"),
    ("self_harm", r"\b(cut|cutting|hurt|hurting|harm|harming|burn|burning|punish|punishing|scratch|scratching) ?my ?self\b"),
    ("self_harm", r"\bself[- ]?harm|\bcutting again\b|\bi cut again\b"),
    ("harm_others", r"\b(kill|hurt|stab|shoot|strangle|beat up) (him|her|them|someone|somebody|people|my (husband|wife|"
                    r"father|mother|dad|mom|mum|boss|brother|sister|son|daughter|kids?|children|baby|neighbou?r|colleague))\b"),
    ("abuse", r"\b(he|she|they|my (husband|wife|father|mother|dad|mom|mum|partner|boyfriend|girlfriend|brother|uncle|"
              r"stepfather|boss)) (hits|beats|hit|beat|chokes|choked|rapes|raped|abuses|abused|threatens|threatened|"
              r"touches|touched) me\b"),
    ("abuse", r"\b(i was|i am|i'?m|being|been|got) (raped|abused|beaten|assaulted|molested)\b|"
              r"\bdomestic (violence|abuse)\b|\bsexual(ly)? (abuse|assault|abused|assaulted)\b"),
]
FR = [
    ("suicidal", r"\bsuicid|\bme tuer\b|\bme suicider\b"),
    ("suicidal", r"\b(veux|voudrais|veut|envie de|envie d'|pense a|penser a|prefere|preferer|aimerais) mourir\b"),
    ("suicidal", r"\ben finir\b|\bmettre fin a (mes jours|ma vie|tout)\b"),
    ("suicidal", r"\b(plus|pas|aucune) envie de vivre\b|\bplus la force de vivre\b|\bpas envie de (me reveiller|vivre)\b"),
    ("suicidal", r"\bne (plus|pas) (me )?reveiller\b|\bne jamais (me )?reveiller\b"),
    ("suicidal", r"\bmieux (sans moi|si je n'?etais (plus )?la|mort|morte)\b|\bdisparaitre (pour toujours|a jamais|definitivement)\b"),
    ("self_harm", r"\bme (faire du mal|fais du mal|suis fait du mal|blesse|blesser|coupe|couper|scarifie|scarifier|mutile|mutiler|griffe|griffer|brule|bruler)\b"),
    ("self_harm", r"\bautomutil|\bscarification|\bme fais mal (expres|volontairement)\b"),
    ("harm_others", r"\b(le|la|les|lui) (tuer|buter|egorger)\b|\bfaire du mal a (quelqu'?un|mon|ma|mes|mon enfant)\b"),
    ("abuse", r"\b(il|elle|ils|mon mari|ma femme|mon pere|ma mere|mon copain|mon conjoint|mon frere|mon oncle|mon patron) "
              r"me (frappe|bat|battait|frappait|viole|violait|menace|maltraite|etrangle|touche)\b"),
    ("abuse", r"\bviol\b|\bviolences? (conjugales?|sexuelles?|domestiques?)\b|\b(j'ai ete|je suis|etre) "
              r"(violee?|battue?|agressee?|abusee?|maltraitee?)\b"),
]
AR = [
    ("suicidal", r"انتحار|انتحر|ننتحر|نتنحر|اتنحر|نقتل روحي|اقتل نفسي|نقتل نفسي"),
    ("suicidal", r"(اريد|ابغي|نحب|نبي|بدي|نبغي|نتمني|اتمني)( ان)? (اموت|نموت)"),
    ("suicidal", r"(انهي|ننهي|نكمل علي|اضع حدا ل) ?(حياتي|عمري)"),
    ("suicidal", r"(لا اريد|ما نحبش|ما نبغيش|ما عادش نحب|لم اعد اريد) (ان )?(اعيش|نعيش)"),
    ("suicidal", r"الموت (احسن|افضل|ارحم)|(احسن|افضل) لو (مت|نموت)|(ما صحيتش|لا استيقظ|ما نفيقش)"),
    ("suicidal", r"(يرتاح|يرتاحو|يرتاحون|افضل حالا) (لو|من غير|بدوني|بلا)|(نختفي|اختفي) (من الدنيا|للابد)"),
    ("self_harm", r"(اذي|اذيت|نؤذي|نوذي|ناذي|نأذي|نضرب|اضرب|اجرح|نجرح|نقطع|اقطع|احرق|نحرق) (نفسي|روحي|في روحي|جسمي)"),
    ("self_harm", r"ايذاء النفس|ايذاء نفسي|اذيه النفس"),
    ("harm_others", r"اقتله|اقتلها|اقتلهم|نقتله|نقتلها|نقتلو|نقتلهم|ايذاء (شخص|احد|الناس)|(نؤذي|اوذي|نوذي) (حد|احد|الناس)"),
    # present tense / named person only: "ضربني البرد" (I caught a cold) must not match
    ("abuse", r"يضربني|تضربني|يضربوني|يعنفني|تعنفني|اغتصبني|اغتصاب|يتحرش بي|تحرش بي|عنف (اسري|زوجي|منزلي|جنسي)|"
              r"ضربني (بابا|ابي|راجلي|زوجي|خويا|اخي|امي|ماما)"),
]
AEB = [  # patterns on norm_derja(): 7->h 9->q 3->a 5->kh, ou->u, ch->sh, doubles collapsed
    ("suicidal", r"\bn?h[aie]b\s+(?:ne?\s*)?mut\b|\bn?h[aie]b\s+nemut\b"),
    ("suicidal", r"\bn[aeiou]?nt[aeiou]?har\b|\bntahar\b|\bnq[aeiou]?t[aeiou]?l\s+r[ou]+h[iy]\b"),
    ("suicidal", r"\b(?:ma\s*a?desh|ma)\s*n?h[aie]b(?:sh)?\s+na?[iy]sh\b|\bn?h[aie]bsh\s+na?[iy]sh\b"),  # ma3adech -> madesh
    ("suicidal", r"\bnkam[ae]l\s+a?la\s+ha?yat[iy]\b|\bnkam[ae]l\s+a?la\s+r[ou]+h[iy]\b"),
    ("suicidal", r"\b(?:khir|khir|ahsen|ahsan)\s+(?:li\s+)?(?:ne?\s*)?mut\b"),
    ("suicidal", r"\brabi\s+(?:khudni|hezni|hazni|ykhudni)\b|\b(?:khudni|hezni)\s+ya\s+rabi\b"),
    # "better if I didn't wake up": "ma nfi9ch" alone also means "I don't wake up (early)", so require the lead-in
    ("suicidal", r"\b(?:ahsen|ahsan|khir)\s+(?:li\s+)?(?:lu|law|ken|kan)\s+ma\s*nf[iy]q|\bn[aeiou]?r[aeiou]?q[aeiou]?d\s+w\s*ma\s*nf[iy]q"),
    ("self_harm", r"\bn[ao]?dh[ao]?r[ao]?b\s+r[ou]+h[iy]\b|\bnqat+a\s+r[ou]+h[iy]\b|\bn[ae]?dh[iy]\s+r[ou]+h[iy]\b"),
    ("harm_others", r"\bnq[aeiou]?t[aeiou]?l(?:u|ha|hom|hum)\b"),                    # n9atlou: I'll kill him
    ("abuse", r"\b[yt][aeiou]?dh[aeiou]?r[aeiou]?bu?ni\b"),                          # yadhrabni: he hits me (present only)
]
PATTERNS = {"en": (norm_latin, EN), "fr": (norm_latin, FR), "ar": (norm_arabic, AR), "aeb": (norm_derja, AEB)}
_COMPILED = {lang: (fn, [(cat, re.compile(p)) for cat, p in pats]) for lang, (fn, pats) in PATTERNS.items()}


PRIORITY = ["suicidal", "self_harm", "harm_others", "abuse"]


def check(text: str) -> dict | None:
    """Most serious crisis phrase found in any language (order: PRIORITY), or None."""
    hits = []
    for lang, (fn, pats) in _COMPILED.items():
        t = fn(text)
        for cat, rx in pats:
            m = rx.search(t)
            if m:
                hits.append({"category": cat, "language": lang, "match": m.group(0)})
    if not hits:
        return None
    return sorted(hits, key=lambda h: PRIORITY.index(h["category"]))[0]


# --------------------------------------------------------------------------- escalation

EMERGENCY_NUMBER = os.environ.get("EMERGENCY_NUMBER", "190")    # SAMU Tunisia: confirm with your clinicians

EMERGENCY_TEXT = {
    "en": "Thank you for telling me. You don't have to go through this alone. A member of our care team "
          "will contact you today. If you or anyone else is in immediate danger, call {num} (SAMU) or go to "
          "the nearest emergency department now.",
    "fr": "Merci de me l'avoir dit. Vous n'êtes pas seul·e face à cela. Un membre de notre équipe de soins "
          "va vous contacter aujourd'hui. Si vous ou quelqu'un d'autre êtes en danger immédiat, appelez le "
          "{num} (SAMU) ou rendez-vous aux urgences les plus proches.",
    "ar": "شكرًا لأنك أخبرتني. لست وحدك في هذا. سيتواصل معك أحد أفراد فريق الرعاية اليوم. "
          "إذا كنت أنت أو أي شخص آخر في خطر الآن، اتصل بالرقم {num} (الإسعاف) أو توجه فورًا إلى أقرب قسم استعجالي.",
    # Derja: draft, needs native review
    "aeb": "Ya3tik essa7a elli 9oltli. Enti mouch wa7dek. Wa7ed mel équipe mte3na bech yetsel bik lyoum. "
           "Ken enti wala 7ad ekher fi khatar tawa, kallem {num} (SAMU) wala emchi lel urgence el a9rab.",
}


def emergency_text(language: str) -> str:
    return EMERGENCY_TEXT.get(language, EMERGENCY_TEXT["en"]).format(num=EMERGENCY_NUMBER)


def escalate(session_id: str, reason: str, message: str, language: str, detail: dict | None = None) -> None:
    """Record an escalation and notify the care team.

    Always appends to data/escalations.jsonl. If ESCALATION_WEBHOOK_URL is set (Slack, Teams, your own
    endpoint), also POSTs the alert there. Never raises: a failed notification must not break the chat.
    """
    rec = {"time": time.strftime("%Y-%m-%dT%H:%M:%S"), "session_id": session_id, "reason": reason,
           "language": language, "message": message, "detail": detail or {}}
    try:
        ESCALATION_LOG.parent.mkdir(parents=True, exist_ok=True)
        with ESCALATION_LOG.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError as e:
        print(f"escalation log failed: {e}")
    url = os.environ.get("ESCALATION_WEBHOOK_URL")
    if url:
        import urllib.request
        try:
            req = urllib.request.Request(url, data=json.dumps({"text": f"[ESCALATION] session {session_id}: "
                                                               f"{reason}", **rec}).encode(),
                                         headers={"Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=5).close()
        except Exception as e:
            print(f"escalation webhook failed: {e}")


# --------------------------------------------------------------------------- evaluation

def _evaluate():
    import pandas as pd
    root = HERE.parent
    frames = [pd.read_csv(root / "mh_dataset" / "data" / "combined" / "test.csv").assign(part="real")]
    syn = HERE / "data" / "labelled_messages.jsonl"
    if syn.exists():
        frames.append(pd.read_json(syn, lines=True).assign(part="synthetic"))
    df = pd.concat(frames, ignore_index=True).dropna(subset=["text"])
    df["risk"] = df["mental_state"].isin(["suicidal", "self_harm"])
    df["hit"] = df["text"].map(lambda t: check(t) is not None)
    print("Crisis phrases on labelled data (synthetic: phrases were written after seeing samples, so "
          "recall there is optimistic):\n")
    print("part       lang  risk recall   false-alarm rate on non-risk")
    for (part, lang), g in df.groupby(["part", "language"]):
        r, n = g[g.risk], g[~g.risk]
        print(f"{part:<10} {lang:<5} {r.hit.mean() if len(r) else float('nan'):>6.1%} of {len(r):<5} "
              f"{n.hit.mean():>6.1%} of {len(n)}")
    rev = HERE / "data" / "derja_review.csv"
    if rev.exists():
        d = pd.read_csv(rev, encoding="utf-8-sig")
        d["hit"] = d["text"].map(lambda t: check(t) is not None)
        risk = d.target.isin(["suicidal", "self_harm"])
        print(f"\nDerja (unreviewed Haiku output): {d[risk].hit.mean():.1%} of {risk.sum()} risk messages, "
              f"false alarms {d[~risk].hit.mean():.1%} of {(~risk).sum()}")


if __name__ == "__main__":
    import sys
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if sys.argv[1:] == ["--eval"]:
        _evaluate()
    else:
        for text in sys.argv[1:]:
            hit = check(text)
            print(f"{'CRISIS ' + hit['category'] + ' [' + hit['language'] + ': ' + hit['match'] + ']' if hit else 'none':<55} | {text}")
