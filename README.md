# Auzy AI v2: the patient chat assistant, as an API

The new assistant behind the Auzy patient chat, packaged as a service that auzy-backend calls over HTTP.

**What it does:**
- answers patients in English, French, Arabic and Tunisian Derja;
- checks every message for risk and alerts the care team;
- writes one analysis per conversation: the Cognisys update, a clinician summary and, when credits run out, the
  patient's pre-diagnostic.

**Cost:** held at $50–80 per 1,000 conversations. Today's chat costs about $1,580.

**What kind of system it is:** an assistant built as a guided workflow, not an autonomous agent. Code decides every
step. Claude writes the replies and can use three read-only lookups: professionals, the patient's own appointments,
and screening tests.

## What's in this package

| Path | What it is |
|---|---|
| `auzy-ai-v2/` | The API (Node 20+):<br>`server/` HTTP API<br>`src/` the engine<br>`integration/` code to add to auzy-backend<br>tests, `openapi.yaml`, `README.md` (API reference) |
| `assistant/` | **auzy-risk**, the safety service (Python): crisis phrases in 4 languages plus a multilingual risk model. Also the pipeline that built and trained the model. |
| `mh_dataset/` | The dataset build behind the risk model |
| `docker-compose.yml`, `.env.example` | Run the API and auzy-risk together |
| `docs/progress-report.html` | Project report: decisions, measured costs, open questions |

The trained risk models come in a separate archive, `auzy-risk-model-xlmr.zip` (1.1 GB): XLM-R and the small TF-IDF fallback.

## How it fits into Auzy

```
patient (React chat) ─► auzy-backend: POST /chat/conversation/:id/messages   (credits deducted as today)
                          │ test account?  no ─► today's chat, unchanged
                          │                yes ─► queue ai_v2_request ─► integration/.../ai_v2.queue.js
                          ▼
                     auzy-ai-api  POST /v1/messages ──► auzy-risk /assess   (crisis phrases + risk model, ~30 ms, free)
                          │   reply, card ids, escalation state            Claude: Haiku 5.5 routine, Sonnet 5.5 for risk
                          │   ◄── lookups and Cognisys snapshot: GET/POST auzy-backend /internal/ai/*
                          ▼
                     auzy-backend saves the assistant message ─► Socket.IO, as today (+ emergency banner while escalated)

after the conversation (credits reach 0, or 30 min without a message):
  auzy-ai-api ─► one analysis ─► POST auzy-backend /internal/ai/analysis ─► Cognisys + pre-diagnostic + notification
                               ─► clinician summary, kept in the API (GET /v1/summaries) and sent to the care-team webhook
```

**Only test accounts use it.**
- auzy-backend sends a profile's messages to the API only when the profile is listed in `AI_V2_TEST_PROFILES`.
- Everyone else keeps today's chat.
- If the API can't be reached, the message is answered by today's chat.

**Rollback:** set `AI_V2_ENABLED=false` in auzy-backend. There is nothing else to undo.

## Transfer steps

1. **Check the archives**
   - Linux: `sha256sum -c MANIFEST.txt`, next to the two zips.
   - Windows: `Get-FileHash -Algorithm SHA256 <zip>`, then compare with `MANIFEST.txt`.
2. **Unpack**
   - Unzip `auzy-ai-api.zip`.
   - Unzip `auzy-risk-model-xlmr.zip` into `assistant/models/`, so that `assistant/models/risk-xlmr/model.safetensors` and
     `assistant/models/risk-tfidf.joblib` exist.
   - The same code is also a git repository (`auzy-ai-api/`, one commit) that you can push to your code host. The
     model is not in it; `.gitignore` keeps it out.
3. **Configure**
   - Copy `.env.example` to `.env` and fill it in.
   - Use a **new** Anthropic API key. The development key was shared in a chat and must be revoked.
   - Generate three different random secrets: `AUZY_AI_API_KEY`, `AUZY_AI_STAFF_TOKEN`, `AUZY_CALLBACK_SECRET`.
   - Set `MONGODB_URI` with a separate database (`MONGODB_DB=auzy_ai`).
   - Set `AUZY_CALLBACK_URL` to the address of auzy-backend's `/internal/ai`.
   - Set the care-team webhook URLs, `EMERGENCY_NUMBER` (confirm it with your clinicians) and `AI_API_BIND`.
4. **Start**
   - Run `docker compose up -d --build`.
   - `GET http://<AI_API_BIND>:8080/v1/health` should return `"ok": true` and `"riskService": {"ok": true}`.
   - **Docker was not available on the development machine, so neither image has been built yet.** Build and check
     them on your server first.
   - Without Docker, see "Run without Docker" in `auzy-ai-v2/README.md`.
5. **auzy-backend** (five new files and two small patches; no existing file is replaced):
   - Copy `auzy-ai-v2/integration/auzy-backend/src/` into auzy-backend's `src/`.
   - From inside auzy-backend, run `git apply -p2 <package>/auzy-ai-v2/integration/patches/auzy-backend-*.diff`.
   - Mount the callback routes where the app mounts its routes:
     ```js
     import aiToolsRoute from './routes/ai-tools.route.js';
     import aiWebhookRoute from './routes/ai-webhook.route.js';
     app.use('/internal/ai', aiToolsRoute, aiWebhookRoute);
     ```
     Keep `/internal/ai` off the public reverse proxy. Every call also needs the shared secret.
   - Add the variables from `auzy-ai-v2/integration/auzy-backend.env.example`, starting with your own test accounts
     in `AI_V2_TEST_PROFILES`, then restart.
6. **auzy-frontend:** from inside the repository, run
   `git apply -p2 <package>/auzy-ai-v2/integration/patches/auzy-frontend-ChatWindow.jsx.diff`.
   This keeps the emergency banner visible while a conversation is escalated.
7. **Test from the test accounts** (the full checklist is in `auzy-ai-v2/README.md`, "Testing inside Auzy"):
   - Chat in each language.
   - Run out of credits and check the closing message, the Cognisys update and the pre-diagnostic in Auzy.
   - Read the summaries and costs with the staff token.
   - Before trying a crisis message, tell the person on call: it sends a real alert.
8. **Before any real patient**, complete everything in "Before real patients" below.

## Checks already run (all free; no Claude calls)

| Check | Result |
|---|---|
| `npm test` in `auzy-ai-v2/` | **81 pass**: engine 57, HTTP API 17, auzy-backend kit 7. The kit test runs the kit's files against stand-ins for auzy-backend's modules. |
| `test/mongo.store.check.mjs` | **9/9** against a real MongoDB (throwaway database) |
| `test/e2e.local.mjs`: real API process, real MongoDB, real auzy-risk, stand-ins for Claude and auzy-backend, one restart midway | **9/9**: crisis → escalation and alert; tool cards; analysis delivered; state kept across the restart; idle analysis; risk service down → careful model |
| `python -m assistant.test_risk_server` (project root) | **8/8** |
| `test/integration.risk.mjs` (engine against auzy-risk) | passes; 31 ms per message on CPU |
| The patches | apply cleanly to the files of the 2026-10-27 export, and the patched files still parse |

**Not run yet:**
- Docker builds.
- The kit inside the real auzy-backend.
- The API with real Claude calls. The engine itself was run with real Claude on 2026-10-27: every request format
  was accepted.

## Measured costs (real Claude calls, 2026-10-27)

| Conversation | Cost |
|---|---|
| Today's chat (Opus 4.8, Cognisys re-analysed after almost every reply) | about $1.58 per conversation |
| English, routine, 6 messages + analysis | $0.015 |
| Derja, abuse disclosure (crisis), 3 messages + urgent summary + analysis | $0.062 |
| Derja, routine, 10 messages + analysis (standard level) | $0.094 |

A daily governor keeps the average between $50 and $80 per 1,000 conversations by choosing the quality level.

| Users writing Arabic/Derja | Level the governor settles on | Expected cost per 1,000 |
|---|---|---|
| 85% | economy | about $51 |
| 60% | standard | about $70 |
| 30% | premium | about $71 |
| 0% | premium | about $58 |

These estimates assume 10% crisis conversations. Each conversation has a ceiling of 15¢, which never applies to safety.

## Before real patients

**Clinical review by native-speaker clinicians:**
- the Arabic and Derja crisis phrases (`assistant/safety.py`);
- the emergency texts (`auzy-ai-v2/src/lib/ai/safety/emergency.js`);
- the system prompt (`auzy-ai-v2/src/lib/ai/prompts/chat.prompt.js`);
- the 400-message Derja sheet (`assistant/data/derja_review_sample.csv`), then retrain the risk model.

**Known quality issues from testing:**
- "3amin" (two years) was once translated as "one year".
- Some Derja wording sounds unnatural.
- The risk model gives false alarms on some formal Arabic. These go to a Sonnet second opinion, never straight to an alert.

**Decisions still open:**
- Which language should the pre-diagnostic use for Derja speakers? The prompt asks for the patient's language, as
  today's chat does, but in testing a Derja speaker's pre-diagnostic came out in French. Decide between Derja (Latin
  or Arabic script), Arabic and French, then say so in `src/lib/ai/prompts/analysis.prompt.js`.
- Which roles may read the staff views?
- Should an escalation also notify the consultant inside the app?

**Before go-live:**
- **Emergency number:** `190` (SAMU) is the default; confirm it.
- **Escalation duty:** name a person on call, and put the escalation webhook in a channel they watch.
- **Legal:** consent and information for patients about AI use, and health-data processing. Anthropic receives the
  conversation text, so check your data agreement.
- **Data minimisation:** delete old conversations and summaries according to your retention rules.
- **API key:** the development key must be revoked.
- **Scale:** the API runs as **one instance** for this test phase. The lock and scheduler are in-process. Several
  instances would need a shared lock, for example the Redis lock in `auzy-ai-v2/in-backend-option/`.
