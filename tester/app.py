"""Auzy AI tester: chat with the assistant through the API as a test patient, and read the staff views.

    python tester/run_local.py           starts the API (and auzy-risk) locally, then this page
    cd tester && streamlit run app.py    this page only, for an API that is already running

The sidebar holds the API address and keys (defaults: AUZY_AI_URL, AUZY_AI_API_KEY, AUZY_AI_STAFF_TOKEN). The page
sends each message the way auzy-backend does. With a real Claude key every message costs money (about 0.1-1 cent;
a crisis conversation about 6 cents), and a crisis message alerts the care-team webhook if the API has one.
"""
from __future__ import annotations

import os
import re
import secrets

import streamlit as st

from api_client import Api, ApiError

st.set_page_config(page_title="Auzy AI tester", page_icon="💬", layout="wide")

HEX24 = re.compile(r"^[0-9a-fA-F]{24}$")
# Names for the built-in sample professionals and tests of AUZY_MODE=demo (the API itself returns ids only).
DEMO_NAMES = {
    "6650000000000000000000a1": "Amina B. · Psychologue clinicienne",
    "6650000000000000000000a2": "Karim S. · Psychiatre",
    "6650000000000000000000a3": "Leila M. · Psychologue",
    "6650000000000000000000b1": "PHQ-9 · dépistage de la dépression",
    "6650000000000000000000b2": "GAD-7 · dépistage de l'anxiété",
    "6650000000000000000000b3": "ISI · sévérité de l'insomnie",
}
SAMPLES = [
    ("English · low mood", "I've been feeling low and tired for weeks, I wake up at 3am thinking about work."),
    ("Français · sommeil", "Je dors mal ces derniers temps, le travail me stresse énormément."),
    ("العربية · قلق", "أشعر بالقلق طوال الوقت ولا أستطيع النوم جيداً"),
    ("Derja · ta3b", "Aslema, ena ta3ban barcha el ayem hedhi w ma nor9odch mli7"),
    ("Ask for a professional", "Can you show me a professional I could talk to?"),
    ("Ask for a test", "Is there a test I could take to understand this better?"),
    ("Ask about appointments", "Do I have an appointment coming up?"),
    ("Indirect risk", "Sometimes I think my family would be better off without me."),
    ("Crisis · Derja (abuse)", "Rajli yadhrabni kol lila w ma3adech najjem"),
    ("Crisis · English", "I want to kill myself, I can't take it anymore."),
]
SAMPLE_PERSONA = {"name": "Auzy", "description": "Assistant de soutien de la plateforme Auzy",
                  "behavior": "chaleureux, mots simples", "rules": ["Keep replies short and kind"]}
LANGUAGE_NOTES = {
    "English": "The patient switched the chat language to English.",
    "Français": "The patient switched the chat language to French.",
    "العربية": "The patient switched the chat language to Arabic.",
    "Derja": "The patient switched the chat language to Tunisian Derja.",
}
NO_SWITCH = "—"
CARD_LABELS = {"profiles": "Professionals", "appointments": "Appointments", "tests": "Screening tests"}

ss = st.session_state
ss.setdefault("api_url", os.environ.get("AUZY_AI_URL", "http://127.0.0.1:8080"))
ss.setdefault("service_key", os.environ.get("AUZY_AI_API_KEY", ""))
ss.setdefault("staff_token", os.environ.get("AUZY_AI_STAFF_TOKEN", ""))
ss.setdefault("conversation_id", secrets.token_hex(12))
ss.setdefault("profile_id", secrets.token_hex(12))
ss.setdefault("credits", 10)
ss.setdefault("eligible", True)
ss.setdefault("persona_mode", "Sample persona (Auzy)")
ss.setdefault("lang_switch", NO_SWITCH)
ss.setdefault("messages", [])
ss.setdefault("emergency", None)
ss.setdefault("last_end", None)
# A widget's value can't change once it is drawn: what a send changes is applied here, at the start of the next run.
for key, value in ss.pop("_after_send", {}).items():
    ss[key] = value


def new_conversation():
    ss.conversation_id = secrets.token_hex(12)
    ss.credits = 10
    ss.messages = []
    ss.emergency = None
    ss.last_end = None


def queue(text: str):
    ss.queued = text


def cents(usd) -> str:
    return "—" if usd is None else f"{usd * 100:.2f}¢"


def when(iso) -> str:
    return (iso or "")[:16].replace("T", " ")


@st.cache_data(ttl=15, show_spinner=False)
def fetch_health(url: str) -> dict:
    try:
        return Api(url, "", "").health()
    except ApiError as e:
        return {"error": str(e)}


def persona():
    if ss.persona_mode == "No persona":
        return None
    if ss.persona_mode == "Sample persona (Auzy)":
        return SAMPLE_PERSONA
    rules = [r.strip() for r in ss.get("persona_rules", "").splitlines() if r.strip()]
    return {"name": ss.get("persona_name", ""), "description": ss.get("persona_description", ""),
            "behavior": ss.get("persona_behavior", ""), "rules": rules}


# ---------------------------------------------------------------- sidebar
with st.sidebar:
    st.header("API")
    st.text_input("API address", key="api_url")
    st.text_input("Service key (AUZY_AI_API_KEY)", type="password", key="service_key")
    st.text_input("Staff token (AUZY_AI_STAFF_TOKEN)", type="password", key="staff_token")
    health = fetch_health(ss.api_url)
    if "error" in health:
        st.error(health["error"])
    elif health.get("ok"):
        st.success(f"Connected · storage {health['store']['kind']} · {health['auzy']} mode · level {health['budgetLevel']}")
        if not health["riskService"]["ok"]:
            st.warning("The risk service is not answering: the careful model answers every message meanwhile.")
    else:
        st.error("The API answers but its storage is down.")

    st.header("Test patient")
    st.text_input("Conversation id", key="conversation_id")
    st.text_input("Profile id", key="profile_id",
                  help="In AUZY_MODE=callback, use a real Auzy test account so the lookups find its data.")
    st.button("New conversation", on_click=new_conversation, width="stretch")
    st.number_input("Credits left", min_value=0, max_value=1000, step=1, key="credits",
                    help="One credit per message, as in Auzy. The message that brings it to 0 gets a closing reply, then the analysis runs.")
    st.checkbox("Eligible for the free consultation", key="eligible",
                help="At 0 credits: pre-diagnostic and free consultation offer (eligible and none yet).")
    st.selectbox("Persona", ["Sample persona (Auzy)", "Custom", "No persona"], key="persona_mode")
    if ss.persona_mode == "Custom":
        ss.setdefault("persona_name", "Sami")
        ss.setdefault("persona_description", "")
        ss.setdefault("persona_behavior", "")
        ss.setdefault("persona_rules", "")
        st.text_input("Name", key="persona_name")
        st.text_area("Description", key="persona_description", height=68)
        st.text_input("Tone", key="persona_behavior")
        st.text_area("Rules (one per line)", key="persona_rules", height=68)
    st.selectbox("Chat language switch (sent with the next message)", [NO_SWITCH, *LANGUAGE_NOTES], key="lang_switch")

api = Api(ss.api_url, ss.service_key, ss.staff_token)
cid = ss.conversation_id.strip().lower()
pid = ss.profile_id.strip().lower()
ids_ok = bool(HEX24.match(cid) and HEX24.match(pid))


# ---------------------------------------------------------------- rendering helpers
def render_cards(cards: dict):
    for key, label in CARD_LABELS.items():
        ids = cards.get(key) or []
        if ids:
            with st.container(border=True):
                st.markdown(f"**{label}** ({len(ids)})")
                for i in ids:
                    st.markdown(f"- {DEMO_NAMES.get(i, i)}")


def render_message(m: dict):
    if m["role"] == "user":
        with st.chat_message("user"):
            st.markdown(m["text"])
            if m.get("notes"):
                st.caption(" · ".join(m["notes"]))
    elif m["role"] == "error":
        st.error(m["text"])
    else:
        r = m["meta"]
        with st.chat_message("assistant"):
            st.markdown(r["reply"])
            render_cards(r.get("cards") or {})
            parts = [r.get("model") or "no model (fallback text)", f"state {r.get('state')}", r.get("language") or "",
                     f"{cents(r.get('costUsd'))} this message", f"{cents(r.get('conversationCostUsd'))} this sitting"]
            if r.get("riskFlag"):
                parts.append(f"risk flag: {r['riskFlag']}")
            if r.get("followUp"):
                parts.append("then: " + ", ".join(r["followUp"]))
            st.caption(" · ".join(p for p in parts if p))
            if r.get("error"):
                st.warning(f"Claude failed ({r['error']}): this is the fallback text.")


def render_summary(s: dict, with_conversation: bool = False):
    sm = s.get("summary") or {}
    title = " · ".join(p for p in ["URGENT" if s.get("urgent") else "", s.get("trigger"), when(s.get("createdAt")), s.get("model") or "",
                                   f"conversation …{s['conversationId'][-6:]}" if with_conversation else ""] if p)
    with st.expander(title, expanded=bool(s.get("urgent"))):
        st.markdown(f"**Narrative:** {sm.get('narrative', '')}")
        st.markdown(f"**Main concerns:** {sm.get('main_concerns', '')}")
        if sm.get("risk_flags"):
            st.markdown(f"**Risk flags:** {', '.join(sm['risk_flags'])} · {sm.get('urgency_reason', '')}")
        st.markdown(f"**Consultation:** {sm.get('consultation', '')} · **Suggested screening:** {', '.join(sm.get('suggested_screening') or []) or '—'}")
        st.json(sm, expanded=False)


def render_diagnostic(d: dict):
    st.markdown("**Pre-diagnostic shown to the patient**")
    st.write(d.get("summary", ""))
    for c in d.get("concerns") or []:
        st.markdown(f"- {c.get('name')} ({c.get('severity')}): {c.get('note')}")
    st.write(d.get("recommendation", ""))


def render_analysis(a: dict):
    with st.expander(f"{a.get('trigger')} · {when(a.get('createdAt'))} · {a.get('model') or ''} · delivery: {a.get('delivery')}"):
        if a.get("lastError"):
            st.warning(f"Last delivery error: {a['lastError']} (attempt {a.get('attempts')})")
        result = a.get("result") or {}
        if result.get("diagnostic"):
            render_diagnostic(result["diagnostic"])
        st.markdown("**Cognisys update**")
        st.json(result.get("cognisys") or {}, expanded=False)


def send(text: str):
    if not ids_ok:
        st.error("The conversation and profile ids must be 24 hexadecimal characters.")
        return
    if ss.credits <= 0:
        st.warning("No credits left: add credits in the sidebar or start a new conversation.")
        return
    notes = [LANGUAGE_NOTES[ss.lang_switch]] if ss.lang_switch in LANGUAGE_NOTES else []
    payload = {"conversationId": cid, "profileId": pid, "text": text, "persona": persona(), "notes": notes,
               "creditsRemaining": ss.credits - 1, "freeConsultationEligible": bool(ss.eligible)}
    ss.messages.append({"role": "user", "text": text, "notes": notes})
    with st.chat_message("user"):
        st.markdown(text)
    with st.spinner("The assistant is answering…"):
        try:
            reply = api.send(payload)
        except ApiError as e:
            ss.messages.append({"role": "error", "text": str(e)})
            st.rerun()
    ss.messages.append({"role": "assistant", "meta": reply})
    ss.emergency = reply.get("emergencyText") if reply.get("escalated") else None
    ss._after_send = {"credits": ss.credits - 1, "lang_switch": NO_SWITCH}
    st.rerun()


# ---------------------------------------------------------------- page
st.title("Auzy AI tester")
st.caption("You are the patient; the page plays auzy-backend's part. Messages go to the API with the service key; "
           "the staff tabs use the staff token.")
if os.environ.get("AUZY_TESTER_STAND_IN") == "1":
    st.info("Stand-in Claude: replies are canned and cost nothing. They check the screens and flows, not the assistant's quality.")

tab_chat, tab_conversation, tab_summaries, tab_costs = st.tabs(["Chat", "Conversation", "Summaries", "Costs"])

with tab_chat:
    if ss.emergency:
        st.error(ss.emergency, icon="🚨")
    for message in ss.messages:
        render_message(message)
    if ss.credits == 0 and ss.messages:
        st.info("No credits left. The end-of-conversation analysis runs in the background: see the Conversation tab in a few seconds.")
    with st.expander("Sample messages"):
        columns = st.columns(2)
        for i, (label, text) in enumerate(SAMPLES):
            columns[i % 2].button(label, key=f"sample_{i}", on_click=queue, args=(text,), width="stretch")
        st.caption("The crisis samples alert the care-team webhook if the API has ESCALATION_WEBHOOK_URL set.")
    left, right = st.columns(2)
    if left.button("End the conversation now", width="stretch",
                   help="Runs the end-of-conversation analysis now; normally automatic (0 credits, or 30 minutes without a message)."):
        try:
            with st.spinner("Analysing the conversation…"):
                ss.last_end = api.end(cid)
        except ApiError as e:
            ss.last_end = {"status": "error", "message": str(e)}
    if right.button("Clear the escalation", width="stretch", disabled=not (ss.emergency and ss.staff_token),
                    help="What a clinician does after following up: later replies go back to the routine model. Needs the staff token."):
        try:
            if api.clear_escalation(cid).get("cleared"):
                ss.emergency = None
                st.toast("Escalation cleared")
                st.rerun()
        except ApiError as e:
            st.error(str(e))
    if ss.last_end:
        end = ss.last_end
        if end.get("status") == "done":
            with st.container(border=True):
                st.markdown(f"**End-of-conversation analysis** · {end.get('model')} · delivery: {end.get('delivery')}")
                render_summary({"summary": end.get("clinicianSummary"), "trigger": "now", "urgent": (end.get("clinicianSummary") or {}).get("urgent")})
                if end.get("diagnostic"):
                    render_diagnostic(end["diagnostic"])
        elif end.get("status") == "nothing_to_analyse":
            st.info("Nothing new to analyse in this conversation.")
        else:
            st.error(end.get("message", "The analysis failed."))
    typed = st.chat_input("No credits left" if ss.credits == 0 else "Write as the patient…", disabled=ss.credits == 0)
    to_send = typed or ss.pop("queued", None)
    if to_send:
        send(to_send)

with tab_conversation:
    st.button("Refresh", key="refresh_conversation")
    if not ss.staff_token:
        st.info("Add the staff token in the sidebar to see the conversation's state.")
    elif not ids_ok:
        st.info("Enter valid ids in the sidebar.")
    else:
        try:
            c = api.conversation(cid)
        except ApiError as e:
            if e.status == 404:
                st.info("No message in this conversation yet.")
            else:
                st.error(str(e))
        else:
            escalation = c.get("escalation") or {}
            cols = st.columns(4)
            cols[0].metric("Escalated", "yes" if escalation.get("active") else "no")
            cols[1].metric("Messages", c.get("totalTurns", 0), help=f"{c.get('turnsThisSession', 0)} in the current sitting")
            cols[2].metric("Sitting", c.get("sessionNumber") or 1)
            cols[3].metric("Cost", cents(c.get("totalCostUsd")))
            if escalation.get("reason"):
                state = "active" if escalation.get("active") else f"cleared {when(escalation.get('clearedAt'))}"
                st.markdown(f"**Escalation** ({state}), since {when(escalation.get('since'))}: {escalation['reason']}")
            analysis = "running" if c.get("analysisRunning") else ("due after the idle time" if c.get("needsAnalysis") else "up to date")
            st.caption(f"Analysis: {analysis} · language {c.get('language') or '—'} · last message {when(c.get('lastTurnAt'))}")
            st.subheader("Screening signals")
            st.dataframe([{"message": s.get("turn"), "state": s.get("state"), "risk score": s.get("riskScore"),
                           "model": s.get("model"), "risk flag": s.get("riskFlag"), "signals": "; ".join(s.get("reasons") or [])}
                          for s in c.get("signals") or []], width="stretch", hide_index=True)
            st.subheader("Clinician summaries")
            for s in c.get("summaries") or []:
                render_summary(s)
            if not c.get("summaries"):
                st.caption("None yet: written when the conversation escalates, and at its end.")
            st.subheader("End-of-conversation analyses")
            for a in c.get("analyses") or []:
                render_analysis(a)
            if not c.get("analyses"):
                st.caption("None yet: written at 0 credits, after the idle time, or with “End the conversation now”.")

with tab_summaries:
    urgent_only = st.checkbox("Urgent only", key="summaries_urgent")
    st.button("Refresh", key="refresh_summaries")
    if not ss.staff_token:
        st.info("Add the staff token in the sidebar to read the clinician summaries.")
    else:
        try:
            items = api.summaries(urgent_only, 50)["items"]
        except ApiError as e:
            st.error(str(e))
        else:
            for s in items:
                render_summary(s, with_conversation=True)
            if not items:
                st.caption("No summary yet.")

with tab_costs:
    days = st.number_input("Days", min_value=1, max_value=365, value=7, key="cost_days")
    st.button("Refresh", key="refresh_costs")
    if not ss.staff_token:
        st.info("Add the staff token in the sidebar to see the costs.")
    else:
        try:
            k = api.costs(int(days))
        except ApiError as e:
            st.error(str(e))
        else:
            budget = k.get("budget") or {}
            low, high = (budget.get("targetPer1000Usd") or [None, None])[:2]
            cols = st.columns(4)
            cols[0].metric("Spent", f"${k.get('totalUsd', 0):.4f}")
            cols[1].metric("Conversations", k.get("conversations", 0))
            per1000 = k.get("per1000FinishedUsd")
            cols[2].metric("Per 1,000 finished", "—" if per1000 is None else f"${per1000:.2f}",
                           help=f"Target ${low}–{high}; measured over {k.get('finishedConversations', 0)} finished conversations")
            cols[3].metric("Budget level", budget.get("level", "—"))
            st.dataframe([{"kind": r.get("kind"), "model": r.get("model"), "calls": r.get("calls"), "cost": f"${r.get('usd', 0):.4f}",
                           "cache hits": f"{(r.get('cacheHitShare') or 0) * 100:.0f}%", "output tokens": r.get("outputTokens")}
                          for r in k.get("byKindAndModel") or []], width="stretch", hide_index=True)
