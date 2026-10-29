# Option: the engine inside auzy-backend (not needed for the API)

The API is the recommended way to test AI v2. These files are an alternative for later: the same engine wired directly
into auzy-backend, with no extra service. They use auzy-backend's Redis for the per-conversation lock, the idle timer
and the shared budget level, and its RabbitMQ consumer for the turns.

Status: written against the 2026-10-27 export, **not run inside auzy-backend**.

To use it:
1. Copy into auzy-backend's `src/`:
   - from the API: `src/config/ai.config.js`, `src/lib/ai/` and `src/model/`;
   - from this folder: `src/lib/ai/index.js`, `src/queues/` and `src/routes/ai.route.js`.
2. Replace `src/queues/completion_request.queue.js`. This switches **everyone** to AI v2, not just test accounts.
3. Apply `patches/` with `git apply -p2`. These are not the patches in `../integration/patches/`.
4. Where the queues are loaded, import `./queues/ai_session.scheduler.js` instead of the Cognisys analysis scheduler.
5. Mount `app.use('/api/v1/ai', aiRoute)`, then set `AI_STAFF_ROLES` and the variables of `../../.env.example`
   (`RISK_SERVICE_URL`, webhooks, budget).
