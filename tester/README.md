# Auzy AI tester (Streamlit)

A page for trying the assistant without Auzy. You write as a test patient; the page sends each message to the API
the way auzy-backend does, and its staff tabs show what the care team would see. It runs on your machine, or on
Streamlit Community Cloud for testers who have nothing installed.

| Tab | What it shows |
|---|---|
| Chat | The greeting that opens the conversation; replies and cards; the emergency banner while a conversation is escalated; the model and cost of each reply; sample messages in four languages; buttons to end the conversation now and to clear an escalation |
| Conversation | The escalation state; the screening signal of each message; the clinician summaries; the end-of-conversation analyses (pre-diagnostic, Cognisys update) and whether they reached auzy-backend |
| Summaries | Every clinician summary, urgent first |
| Costs | Spend; cost per 1,000 finished conversations; budget level; cost by kind of call and by model |

The sidebar sets up the test patient:
- **Credits:** one per message. The message that brings them to 0 gets the closing reply and starts the analysis.
- **Free consultation:** whether the patient is eligible.
- **Persona:** the sample persona, a custom one, or none.
- **Chat language:** the greeting's language, until the patient writes. Changed after that, it reaches the assistant
  with the next message, like Auzy's chat-language menu.

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

Without `AUZY_AI_URL`, `streamlit run app.py` starts its own API instead (the built-in mode below).

## On Streamlit Community Cloud

Without `AUZY_AI_URL`, the page starts its own API inside the app (built-in mode), so it runs there on its own.

1. At https://share.streamlit.io, sign in with the GitHub account that owns `ahmedbahaeddineabid/ausy_help`, and allow
   access to private repositories.
2. Create an app from that repository: branch `main`, main file path `tester/app.py`.
3. In **Advanced settings**, choose Python 3.12 and paste the secrets:

   ```toml
   TESTER_PASSWORD = "..."       # testers type it to open the page: use a long random value
   ANTHROPIC_API_KEY = "..."     # optional, a new key; without it, replies come from the stand-in (no cost)
   TESTER_MAX_SPEND_USD = "1"    # optional: messages pause once the app has spent this much since it started (default 1)
   ```

4. Deploy. The first start takes a few minutes: Community Cloud installs the Python packages (Node 24 among them),
   then the first visit installs the API's packages.

What runs there:
- The API with in-memory storage: everything is lost when the app restarts or goes to sleep.
- The demo catalog: three sample professionals, three tests, no appointments.
- auzy-risk with the small TF-IDF model, because the full XLM-R model is too large for Community Cloud. Crisis phrases
  and the choice between the two Claude models work as in production. In testing, the small model flagged 94% of
  risk messages, against 98% for the full one, and Claude's own risk check still reads every message.
- Everyone who opens the app shares this API, so the staff tabs show every tester's conversations.

Keep it safe:
- An app deployed from a private repository is private. Invite testers by email with **Share**, and keep it private.
- With a Claude key, every message costs money. Also set a spend limit on the key in the Anthropic Console:
  `TESTER_MAX_SPEND_USD` only counts what the app has spent since it last started.
- It is a test page: testers should not type real personal information.

## Check

`python tester/test_app.py` drives the page like a user (Streamlit AppTest). The stand-in answers instead of Claude,
so it costs nothing. It runs 30 checks.

Against a running API, as `run_local.py` starts it:
- connection;
- with the risk service down, a note in the sidebar instead of a warning;
- the greeting: the persona's name, the chat language, no Claude call;
- the greeting reaches Claude with the first message, so the reply doesn't greet again;
- a reply with model and cost;
- a language change mid-conversation;
- cards;
- the emergency banner, the staff view and the urgent summary;
- clearing the escalation;
- the closing reply at 0 credits, then the analysis and pre-diagnostic;
- costs;
- a new conversation;
- no patient text in the API log.

In built-in mode, as on Community Cloud:
- the password;
- the page's own API and auzy-risk with the small model, with nothing on the page that looks like an error;
- the API's address and keys can't be changed from the page;
- the greeting;
- a routine message answered by the routine model;
- the emergency banner on a crisis phrase;
- messages paused past the spend limit.
