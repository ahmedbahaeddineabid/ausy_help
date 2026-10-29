"""Free stand-in for the Claude API, for checking the tester's screens and flows without any cost.

Every reply starts with "[stand-in]": nothing here says anything about the real assistant's quality. It answers like
Claude would in shape (tool calls for professionals, tests and appointments; a risk tag on crisis words; JSON for
the analyses), so cards, escalation, the closing reply and the end-of-conversation analysis can all be exercised.
Started by run_local.py --stand-in; the API reaches it through ANTHROPIC_BASE_URL.
"""
from __future__ import annotations

import json
import re
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

USAGE = {"input_tokens": 120, "output_tokens": 60, "cache_read_input_tokens": 3000, "cache_creation_input_tokens": 0}
CRISIS = re.compile(r"kill myself|suicid|end my life|want to die|hurt myself|mourir|en finir|nmout|نموت|أنهي حياتي|yadhrab|يضربني", re.I)
TOOLS = [
    (re.compile(r"professional|psycholog|therapist|consultant|psy\b|ne7ki m3a|n7ki m3a", re.I), "find_consultants",
     "Here are some professionals you could talk to."),
    (re.compile(r"\btests?\b|questionnaire|phq|gad", re.I), "find_tests", "These screening tests could help."),
    (re.compile(r"appointment|rendez-vous|\brdv\b|maw3ed", re.I), "get_my_appointments", "Here is what I found about your appointments."),
]

SUMMARY = {
    "urgent": False, "urgency_reason": "not discussed", "risk_flags": [], "main_concerns": "[stand-in] stress et sommeil",
    "symptoms": [{"symptom": "sommeil réduit", "duration": "quelques semaines", "frequency_severity": "la plupart des nuits"}],
    "triggers_stressors": "travail", "sleep": "réveils à 3 h", "appetite": "not discussed", "functioning": "not discussed",
    "history": "not discussed", "risk_factors": "not discussed", "protective_factors": "not discussed",
    "suggested_screening": ["PHQ-9"], "consultation": "agreed", "patient_language": "en",
    "narrative": "[stand-in] Résumé fictif produit sans appel à Claude.",
}
COGNISYS = {
    "facts": [{"category": "sleep", "key": "night-waking", "value": "3am", "valueType": "string", "unit": "", "confidence": 70, "source": "confessed"}],
    "dimensions": [{"dimension": "sleep", "score": 35, "factors": ["wakes at 3am"]}],
    "analysisAppend": {"analysisType": "periodic", "summary": "[stand-in] analysis"},
    "profile": {"summary": "[stand-in] profile summary", "tags": ["sleep"], "keyInsights": [], "riskFactors": [], "opportunities": []},
}
DIAGNOSTIC = {
    "summary": "[stand-in] What the conversation suggests (no Claude call was made).",
    "concerns": [{"name": "Sleep disturbance", "severity": "mild", "note": "[stand-in] note"}],
    "recommendation": "[stand-in] Book the free 15-minute consultation.",
}


def _texts(message) -> list[str]:
    content = message.get("content")
    if isinstance(content, str):
        return [content]
    return [b.get("text", "") for b in content or [] if b.get("type") == "text"]


def answer(req: dict) -> dict:
    def message(content, stop="end_turn"):
        return {"id": f"msg_{uuid.uuid4().hex[:12]}", "type": "message", "role": "assistant", "model": req.get("model"),
                "content": content, "stop_reason": stop, "stop_sequence": None, "usage": USAGE}

    schema = (req.get("output_config") or {}).get("format", {}).get("schema", {}).get("properties")
    if schema:
        if "cognisys" in schema:
            out = {"cognisys": COGNISYS, "clinicianSummary": SUMMARY}
            if "diagnostic" in schema:
                out["diagnostic"] = DIAGNOSTIC
        else:
            out = {**SUMMARY, "urgent": True, "urgency_reason": "[stand-in] crisis words", "risk_flags": ["suicidal"]}
        return message([{"type": "text", "text": json.dumps(out, ensure_ascii=False)}])

    messages = req.get("messages", [])
    last = messages[-1] if messages else {}
    if last.get("role") == "user" and isinstance(last.get("content"), list) and any(b.get("type") == "tool_result" for b in last["content"]):
        used = next((b.get("name") for m in reversed(messages) if m.get("role") == "assistant" and isinstance(m.get("content"), list)
                     for b in m["content"] if b.get("type") == "tool_use"), "")
        reply = next((r for _, name, r in TOOLS if name == used), "Here is what I found.")
        return message([{"type": "text", "text": f"[stand-in] {reply}\n<risk>none</risk>"}])

    said = next((t for m in reversed(messages) if m.get("role") == "user" for t in reversed(_texts(m)) if t.strip()), "")
    hint = " ".join(_texts(last)) if last.get("role") == "system" else ""
    if CRISIS.search(said):
        tag = "abuse" if re.search(r"yadhrab|يضربني", said, re.I) else "suicidal"
        text = "[stand-in] I'm really glad you told me. You are not alone: please call 190 now if you are in danger."
        return message([{"type": "text", "text": f"{text}\n<risk>{tag}</risk>"}])
    if "no credits left" in hint:
        return message([{"type": "text", "text": "[stand-in] Thank you for today. A short pre-assessment will appear in your account.\n<risk>none</risk>"}])
    for pattern, tool, _ in TOOLS:
        if pattern.search(said):
            return message([{"type": "tool_use", "id": f"toolu_{uuid.uuid4().hex[:10]}", "name": tool, "input": {}}], "tool_use")
    return message([{"type": "text", "text": "[stand-in] I hear you. Tell me more about what has been happening.\n<risk>none</risk>"}])


class _Handler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802 (http.server naming)
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        data = json.dumps(answer(body)).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):  # keep the console quiet
        pass


def start(port: int = 0) -> ThreadingHTTPServer:
    """Serves in a background thread; returns the server (server.server_address[1] is the port)."""
    server = ThreadingHTTPServer(("127.0.0.1", port), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server
