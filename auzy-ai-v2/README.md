# Auzy AI API (AI v2)

The patient chat assistant as an HTTP service for auzy-backend. Start with `../README.md` (what it is, transfer
steps); this file is the reference for developers.

## How a turn works

```
POST /v1/messages {conversationId, profileId, text, persona, creditsRemaining, freeConsultationEligible, notes, history}
  one turn at a time per conversation (in-process lock)
  1. auzy-risk /assess: crisis phrases (4 languages) + risk model                          free, ~30 ms
       crisis phrase                    -> escalate now (care-team alert + banner); Sonnet answers
       risk model only / service down   -> Sonnet answers; escalation only if Sonnet tags risk
  2. Claude with the persona, 3 lookups and a cached prompt
       Haiku 5.5 (low effort) for routine replies; Sonnet 5.5 for Arabic/Derja at the standard level, risk turns,
       escalated conversations. Haiku tags risk -> its draft is discarded and Sonnet answers the same message.
  3. -> { reply, cards, escalated, emergencyText, ... }; auzy-backend saves and emits the message as today
  after the reply:
     escalated now          -> urgent clinician summary (Sonnet) -> care-team webhook + GET /v1/summaries
     credits now 0          -> closing reply, then the end-of-conversation analysis
     otherwise              -> analysis once the conversation has had no message for AI_IDLE_MINUTES (30)

End-of-conversation analysis, one Claude call:
  Cognisys update + clinician summary + (at 0 credits, if eligible) the patient's pre-diagnostic
  Haiku for English/French; Sonnet for Arabic/Derja and escalated conversations; retried once on Sonnet if unusable
  -> kept in the API, delivered to auzy-backend POST /internal/ai/analysis (retried until accepted)
```

An escalation stays active (Sonnet, banner) until staff clear it: `POST /v1/conversations/:id/clear-escalation`.
The session sent to Claude covers one sitting only; the next one starts with the profile summary and the last
messages, so cost per turn stays bounded.

## Endpoints

Full schemas: `openapi.yaml`. Ids are Auzy's MongoDB ids (24 hexadecimal characters).

| Endpoint | Key | Purpose |
|---|---|---|
| `POST /v1/messages` | service | One patient turn |
| `POST /v1/conversations/:id/end` | service or staff | Run the end-of-conversation analysis now (normally automatic) |
| `GET /v1/conversations/:id` | staff | Escalation state, screening signals, summaries, analyses and their delivery, cost |
| `POST /v1/conversations/:id/clear-escalation` | staff | A clinician followed up: back to the routine model |
| `GET /v1/summaries?urgent=true&limit=50` | staff | Clinician summaries, urgent first |
| `GET /v1/costs?days=30` | staff | Spend, cost per 1,000 finished conversations, budget level, by kind and model |
| `GET /v1/health` | none | Up, storage, risk service, budget level |

Keys go in `Authorization: Bearer <key>`: service = `AUZY_AI_API_KEY` (auzy-backend), staff = `AUZY_AI_STAFF_TOKEN`.

```bash
API=http://127.0.0.1:8080
curl -s $API/v1/health

curl -s -X POST $API/v1/messages -H "Authorization: Bearer $AUZY_AI_API_KEY" -H "Content-Type: application/json" -d '{
  "conversationId": "6650000000000000000000c1", "profileId": "6650000000000000000000d1",
  "text": "Je dors mal ces derniers temps, je me réveille à 3h du matin.",
  "persona": { "name": "Auzy", "description": "Assistant de soutien", "behavior": "chaleureux", "rules": ["Réponses courtes"] },
  "creditsRemaining": 4, "freeConsultationEligible": true }'
# -> {"reply":"...","cards":{"profiles":[],"appointments":[],"tests":[]},"escalated":false,"emergencyText":null,
#     "model":"claude-haiku-5-5","state":"stress","riskFlag":null,"language":"fr","costUsd":0.0011,...,"followUp":[],"error":null}

curl -s "$API/v1/summaries?urgent=true" -H "Authorization: Bearer $AUZY_AI_STAFF_TOKEN"
curl -s "$API/v1/costs?days=7" -H "Authorization: Bearer $AUZY_AI_STAFF_TOKEN"
curl -s -X POST $API/v1/conversations/6650000000000000000000c1/clear-escalation \
  -H "Authorization: Bearer $AUZY_AI_STAFF_TOKEN" -H "Content-Type: application/json" -d '{"clearedBy":"6650000000000000000000d9"}'
```

**What auzy-backend sends** (the kit in `integration/` does all of this):
- `text`: the patient's new message(s) since the last reply, joined with blank lines (max 8,000 characters).
- `persona`: the conversation's assistant or the platform default (name, description, domain, behavior, rules,
  personalization); other fields are ignored.
- `notes`: system messages since the last reply (the chat-language switch).
- `creditsRemaining`: the balance after this message. At 0 the reply closes warmly and the analysis follows.
- `freeConsultationEligible`: at 0 credits, whether the patient gets the pre-diagnostic and the free consultation
  offer (eligible and none yet: the rule of `maybeTriggerDiagnostic`).
- `history`: a few earlier messages; used only for a conversation's first turn on the API, for continuity from
  today's chat.

**What comes back:**
- `reply`: the text to save as the assistant message.
- `cards`: the ids for the message's `profiles`, `appointments` and `tests`, as today.
- `escalated`, `emergencyText`: stored in `metadata.ai`; the frontend patch shows the banner from them.
- `error`: set when Claude failed and `reply` is the fallback text in the patient's language.

**What the API calls in auzy-backend** (implemented by `integration/auzy-backend/src/routes/`, all with
`Authorization: Bearer <AUZY_CALLBACK_SECRET>`):

| Call | Used for |
|---|---|
| `POST /internal/ai/tools/find-consultants` `{search, limit}` -> `{profiles}` | lookup: professionals (cards) |
| `POST /internal/ai/tools/appointments` `{profileId, when, limit}` -> `{appointments}` | lookup: the patient's own appointments; the role is read from the profile |
| `POST /internal/ai/tools/tests` `{search, limit}` -> `{items}` | lookup: screening tests (cards) |
| `GET /internal/ai/cognisys/:profileId` | the stored Cognisys profile, read before each analysis; an error postpones the analysis (it would otherwise overwrite the profile) |
| `POST /internal/ai/analysis` | each analysis: Cognisys update, clinician summary, pre-diagnostic. Retried with a growing delay for about 8 hours; the same `analysisId` every time, so a repeat is ignored |

The lookups return only the fields the assistant and the cards need (no e-mail, phone or account data).

## Configuration

All settings come from the environment (`../.env.example` lists them with comments).

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | required | Claude |
| `AUZY_AI_API_KEY`, `AUZY_AI_STAFF_TOKEN`, `AUZY_CALLBACK_SECRET` | required except the staff token | Three different secrets of at least 32 characters; the API refuses to start otherwise |
| `STORE`, `MONGODB_URI`, `MONGODB_DB` | `mongo`, required, `auzy_ai` | Storage. `STORE=memory` is for local tests only and is refused when `NODE_ENV=production` |
| `AUZY_MODE`, `AUZY_CALLBACK_URL` | `callback`, required | `demo` = built-in sample professionals and tests, no calls to auzy-backend |
| `RISK_SERVICE_URL` | `http://auzy-risk:8001` | auzy-risk |
| `ESCALATION_WEBHOOK_URL`, `SUMMARY_WEBHOOK_URL` | empty | Care-team channel (Slack, Teams or your own endpoint); carries health information |
| `EMERGENCY_NUMBER`, `SUMMARY_LANGUAGE` | `190`, `French` | Banner number; language of clinician summaries |
| `AI_IDLE_MINUTES` | `30` | No message for this long -> end-of-conversation analysis |
| budget | see below | `AI_TARGET_MIN_PER_1000_USD` (50), `AI_TARGET_MAX_PER_1000_USD` (80), `AI_CONVERSATION_CEILING_USD` (0.15), `AI_QUALITY_LANGUAGES` (`ar,aeb`), `AI_START_LEVEL` (1) |
| optional | | `AI_ROUTINE_MODEL`, `AI_CAREFUL_MODEL`, `AI_ROUTINE_EFFORT`, `AI_CAREFUL_EFFORT`, `AI_QUALITY_EFFORT`, `AI_MAX_TEXT_CHARS` (8000), `PORT` (8080), `HOST`, `AI_POLL_MS` (60000) |

What the API stores in its own database:

| Collection | Contents |
|---|---|
| `aisessions` | The Claude-format history of the current sitting, the escalation state and the screening signals |
| `aiusages` | One cost row per Claude call |
| `cliniciansummaries` | Clinician summaries |
| `aianalyses` | Each analysis and its delivery |
| `aiapiconversations` | The latest credit balance, eligibility and persona name per conversation |
| `aisettings` | The budget level |

## Budget: $50–80 per 1,000 conversations

A conversation is one sitting: from the first message until credits run out or 30 minutes of silence.

| Level | Routine replies | Cost per 10-message conversation |
|---|---|---|
| 0 economy | Haiku for everyone | en/fr ~0.3–1.5¢; Arabic/Derja ~4.6¢ (Sonnet still writes their analysis) |
| 1 standard (start) | Sonnet at low effort for Arabic/Derja, Haiku for en/fr | en/fr ~0.3–1.5¢; Arabic/Derja **9.4¢ measured** |
| 2 premium | Sonnet at low effort for everyone | en/fr ~5.3¢; Arabic/Derja 9.4¢ |

At every level a crisis costs ~10–12¢: Sonnet at medium effort, an urgent summary and a Sonnet analysis.

**Governor:** once a day it measures the average cost of the conversations finished over the last 7 days, from the
cost ledger. The level it sets is kept in the database.
- Above $80 per 1,000: the level steps down at once.
- Below $50 per 1,000: the level steps up, at most once every 3 days.
- Fewer than 50 finished conversations: nothing changes.

**Per-conversation ceiling (15¢):** once a conversation has cost this much, its routine replies and its analysis switch
to Haiku. Safety is never limited: second opinions, escalated conversations and urgent summaries keep Sonnet.

## Run without Docker

Needs Node 20.6+ and Python 3.12 with `assistant/requirements.txt`.

```bash
# 1. auzy-risk (from the package root; the model must be in assistant/models/risk-xlmr/)
python -m uvicorn assistant.risk_server:app --host 127.0.0.1 --port 8001
# 2. the API (from auzy-ai-v2/)
npm ci --omit=dev
node --env-file=../.env server/index.js          # with RISK_SERVICE_URL=http://127.0.0.1:8001 in .env
```

For a first try without MongoDB or auzy-backend, set `STORE=memory` and `AUZY_MODE=demo` in `.env`. Everything is
lost when the process stops.

## Testing inside Auzy (test accounts)

1. **Routine conversation**, in each language: English, French, Arabic, Derja in Latin letters.
   - Replies stay in the patient's language and script.
   - "Can you show me a professional?" shows consultant cards.
   - A question about appointments shows the patient's own appointments.
   - A question about tests shows test cards.
2. **Language switch:** change the chat language mid-conversation; the next reply follows it.
3. **Last credit:** a short, warm closing that mentions the pre-assessment.
   - About a minute later, the pre-diagnostic notification appears.
   - The Cognisys screens show the update.
   - `GET /v1/conversations/:id` shows `"delivery": "delivered"`.
4. **Idle:** stop writing for 30 minutes; `GET /v1/conversations/:id` shows a new analysis.
5. **Crisis** (warn the person on call first: it sends a real alert):
   - The reply is careful and includes the emergency number.
   - The banner stays visible.
   - The escalation webhook fires.
   - `GET /v1/summaries?urgent=true` shows the summary.
   - Clear the escalation afterwards.
6. **Costs:** `GET /v1/costs?days=1`, after a few conversations.
7. **Outage:** stop the API; a test account's next message is answered by today's chat.

## Checks

| Command (from `auzy-ai-v2/`) | Needs | What it checks |
|---|---|---|
| `npm test` | nothing | 81 tests: the engine (routing, safety, second opinions, caching, analysis, budget), the HTTP API (keys, validation, every endpoint, escalation, delivery retries, idle analysis, lock, restart of the budget level), and the auzy-backend kit end to end against stand-ins of auzy-backend's modules |
| `MONGODB_URI=... node test/mongo.store.check.mjs` | any MongoDB | the MongoDB store, in a throwaway database it drops afterwards |
| `MONGODB_URI=... node test/e2e.local.mjs` | MongoDB + auzy-risk running | the real API process with stand-ins for Claude and auzy-backend, a restart midway, the risk service down |
| `node test/integration.risk.mjs` | auzy-risk running | the engine against the real risk service |
| `node test/live.check.mjs` | auzy-risk + `ANTHROPIC_API_KEY` | real Claude calls through the engine (about $0.10) |

## Files

| Path | Role |
|---|---|
| `server/index.js` | Startup, settings check, graceful shutdown |
| `server/settings.js` | API settings and the start-up checks |
| `server/api.js` | Wires the engine, the scheduler and the routes |
| `server/routes.js` | HTTP endpoints, keys, validation |
| `server/scheduler.js` | End-of-conversation analysis (0 credits, idle), delivery retries, daily budget governor |
| `server/lock.js` | One turn at a time per conversation |
| `server/auzy.client.js` | Calls to auzy-backend's `/internal/ai` |
| `server/demo.catalog.js` | `AUZY_MODE=demo` stand-ins |
| `server/store/mongo.js`, `server/store/memory.js` | Storage |
| `src/config/ai.config.js` | Models, effort, limits, prices, budget |
| `src/lib/ai/turn.service.js` | One patient turn: routing, second opinions, escalation, cost |
| `src/lib/ai/claude.call.js` | Claude call with caching, adaptive thinking, the tool loop |
| `src/lib/ai/prompts/` | System prompt, persona block, per-turn hint; analysis prompts and schemas |
| `src/lib/ai/analysis.service.js` | Urgent summary; end-of-conversation analysis |
| `src/lib/ai/tools/index.js` | The 3 lookups with compact results |
| `src/lib/ai/safety/` | auzy-risk client; emergency texts and language guess |
| `src/lib/ai/budget.js` | Quality levels and the governor's rule |
| `src/lib/ai/text.js` | Fixes Arabic letters inside Latin-script Derja replies |
| `src/lib/ai/store.mongo.js`, `budget.mongo.js`, `src/model/` | MongoDB models and queries |
| `integration/` | What auzy-backend and auzy-frontend need (see `../README.md`, step 5) |
| `in-backend-option/` | Not needed for the API: the same engine wired directly into auzy-backend (Redis lock, RabbitMQ consumer), for later if you prefer no extra service. Not run inside auzy-backend. |

## Limits of this test version

- **One instance.** The per-conversation lock and the scheduler live in the process.
- **Shutdown.** On SIGTERM the server stops taking requests and finishes its work (up to 30 s). This wasn't
  checked on the development machine (Windows has no SIGTERM).
- **Field lists.** The lists in `src/lib/ai/tools/index.js` and `integration/.../ai-tools.route.js` are best guesses
  at the Profile, Appointment and Agent models. Check them against the real schemas.
- **SDK.** The requests use adaptive thinking, `output_config.effort`, top-level `cache_control` and
  mid-conversation `system` messages. Keep `@anthropic-ai/sdk` up to date.
