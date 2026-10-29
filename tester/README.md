# Auzy AI tester (Streamlit)

A page for trying the assistant without Auzy. You write as a test patient; the page sends each message to the API
the way auzy-backend does, and its staff tabs show what the care team would see.

| Tab | What it shows |
|---|---|
| Chat | Replies and cards; the emergency banner while a conversation is escalated; the model and cost of each reply; sample messages in four languages; buttons to end the conversation now and to clear an escalation |
| Conversation | The escalation state; the screening signal of each message; the clinician summaries; the end-of-conversation analyses (pre-diagnostic, Cognisys update) and whether they reached auzy-backend |
| Summaries | Every clinician summary, urgent first |
| Costs | Spend; cost per 1,000 finished conversations; budget level; cost by kind of call and by model |

The sidebar sets up the test patient:
- **Credits:** one per message. The message that brings them to 0 gets the closing reply and starts the analysis.
- **Free consultation:** whether the patient is eligible.
- **Persona:** the sample persona, a custom one, or none.
- **Chat language:** simulates the chat-language switch.

## On one machine (no Auzy, no MongoDB)

**Needs:**
- Node 20.6+, then `cd auzy-ai-v2 && npm ci --omit=dev`.
- Python 3.12, then `pip install -r tester/requirements.txt`.
- For auzy-risk: `pip install -r assistant/requirements.txt` and the model unzipped in `assistant/models/`.

From the package root:

```bash
python tester/run_local.py --stand-in        # no cost: canned replies, to check the screens and flows

export ANTHROPIC_API_KEY=...                 # PowerShell: $env:ANTHROPIC_API_KEY = "..."
python tester/run_local.py                   # real Claude
```

The launcher starts three things, then opens http://127.0.0.1:8501:
- auzy-risk, if its model is present;
- the API, with in-memory storage and the demo catalog (three sample professionals, three tests, no appointments);
- this page.

Ctrl+C stops everything. The keys for the run are random and are never written to disk.

**What real Claude costs:**

| Message or conversation | Cost |
|---|---|
| A routine English or French message | 0.1–1¢ |
| An Arabic or Derja message | about 0.5¢ |
| A short crisis conversation, with its summaries | about 6¢ |
| The analysis at the end of a conversation | 0.2–4¢ |

## Against an API that is already running (a test server)

```bash
cd tester
export AUZY_AI_URL=http://<api-host>:8080 AUZY_AI_API_KEY=... AUZY_AI_STAFF_TOKEN=...   # or type them in the sidebar
streamlit run app.py
```

Use it on a **test** deployment only:
- The page uses the service key, so its messages are real turns: they cost money, and a crisis message alerts the
  care-team webhook.
- With `AUZY_MODE=callback`, enter the ids of an Auzy test account and of its conversation. The lookups read that
  account, and the end-of-conversation analysis is saved to it (Cognisys, pre-diagnostic).
- The tester's messages don't appear in Auzy's own chat history.

The page binds to 127.0.0.1 and holds the keys, so keep it on your machine.

## Check

`python tester/test_app.py` drives the page like a user (Streamlit AppTest), against a real API process that uses the
stand-in Claude. It runs 15 checks and costs nothing:
- connection;
- a reply with model and cost;
- cards;
- the emergency banner, the staff view and the urgent summary;
- clearing the escalation;
- the closing reply at 0 credits, then the analysis and pre-diagnostic;
- costs;
- a new conversation;
- no patient text in the API log.
