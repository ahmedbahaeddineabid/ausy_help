"""Run: python assistant/test_safety.py   (or pytest assistant/test_safety.py)"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from safety import check, emergency_text  # noqa: E402

MUST_FLAG = [  # (message, expected category)
    ("I want to kill myself", "suicidal"),
    ("honestly i just wanna die", "suicidal"),
    ("Everyone would be better off without me", "suicidal"),
    ("A few times I thought it would be easier if I didn't wake up", "suicidal"),
    ("I don't want to be alive anymore", "suicidal"),
    ("I cut myself again last night", "self_harm"),
    ("When it gets too much I hurt myself, but I don't want to die", "suicidal"),  # suicidal wins: recall first
    ("Je veux mourir, je n'en peux plus", "suicidal"),
    ("J'ai envie d'en finir", "suicidal"),
    ("Ce serait plus simple de ne pas me réveiller", "suicidal"),
    ("Je me fais du mal quand c'est trop", "self_harm"),
    ("أريد أن أنهي حياتي", "suicidal"),
    ("نحب نموت", "suicidal"),
    ("ما نحبش نعيش", "suicidal"),
    ("الكل يرتاح لو ما كنتش موجود", "suicidal"),
    ("كي نتقلق نضرب روحي", "self_harm"),
    ("Nheb nmout, ma3adech najjem", "suicidal"),
    ("n7eb nmout", "suicidal"),
    ("N7ebb nemout", "suicidal"),
    ("ma n7ebch n3ich", "suicidal"),
    ("ma3adech n7eb n3ich", "suicidal"),
    ("5ir li nmout", "suicidal"),
    ("ya rabbi 5oudni", "suicidal"),
    ("bech nontahar", "suicidal"),
    ("ki nt9ale9 nadhrab rou7i", "self_harm"),
    ("a7sen lou ma nfi9ch", "suicidal"),
    ("n7eb nor9od w ma nfi9ch", "suicidal"),
    ("Sometimes I want to hurt my kids when they scream", "harm_others"),
    ("I'm going to kill him", "harm_others"),
    ("My husband hits me when he's drunk", "abuse"),
    ("I was raped last year", "abuse"),
    ("J'ai envie de le tuer", "harm_others"),
    ("Mon mari me frappe", "abuse"),
    ("نحب نقتلو", "harm_others"),
    ("راجلي يضربني كل ليلة", "abuse"),
    ("ken nchoufou n9atlou", "harm_others"),
    ("rajli yadhrabni", "abuse"),
]
MUST_NOT_FLAG = [
    "Work has been stressful but I'm sleeping fine",
    "I can't stop worrying, my chest is tight every day",
    "I'm so tired, I could sleep for a week",
    "Je suis fatiguée et triste depuis des semaines",
    "J'ai fini mon travail, je rentre",
    "الخدمة متعبة برشا أما نرقد مليح",
    "كنت سريع الانفعال بضعة أيام",
    "Labes, el 7amdoulillah, juste chwaya stress mta3 el khedma",
    "N7eb nemchi lel b7ar ghodwa",
    "Ma n7ebch nemchi lel khedma lyoum, ta3ban",
    "Ma nfi9ch bekri, el réveil ma 5dmch",
    "My dad hits the gym every day",
    "Ce boulot me tue",
    "ضربني البرد",
    "I beat my brother at chess",
]


def test_flags():
    for text, cat in MUST_FLAG:
        hit = check(text)
        assert hit is not None, f"missed: {text}"
        assert hit["category"] == cat, f"{text}: got {hit['category']}, expected {cat}"


def test_no_false_alarm():
    for text in MUST_NOT_FLAG:
        assert check(text) is None, f"false alarm: {text} -> {check(text)}"


def test_emergency_text():
    for lang in ("en", "fr", "ar", "aeb", "xx"):
        assert "190" in emergency_text(lang)


if __name__ == "__main__":
    failed = 0
    for fn in (test_flags, test_no_false_alarm, test_emergency_text):
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {fn.__name__}: {e}")
    sys.exit(failed)
