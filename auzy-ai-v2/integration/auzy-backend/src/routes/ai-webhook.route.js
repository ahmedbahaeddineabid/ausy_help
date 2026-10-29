// Receives each end-of-conversation analysis from the Auzy AI API (AI v2) and saves it with auzy-backend's own
// services: the Cognisys update (same collections and screens as today) and, when included, the patient's
// pre-diagnostic with its notification (what maybeTriggerDiagnostic did). The clinician summary stays in the API
// (GET /v1/summaries). The API retries a failed delivery with the same analysisId; a repeat is ignored.
// Mounted with ai-tools.route.js: app.use('/internal/ai', aiToolsRoute, aiWebhookRoute);

import express from 'express';
import mongoose from 'mongoose';
import { redisConnect, setNxEx, getRedis } from '../config/redis.config.js';
import cognisysSvc from '../services/cognisys.service.js';
import { createDiagnostic, getLatestDiagnosticForProfile } from '../services/diagnostic.service.js';
import { createNotification } from '../factories/notification.factory.js';
import { NotificationTypes } from '../enums/notification.enums.js';
import { createCognisysAdapter } from '../lib/ai-v2/cognisys.adapter.js';
import { requireAiSecret } from '../lib/ai-v2/ai-v2.client.js';

const router = express.Router();
const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

router.post('/analysis', express.json({ limit: '1mb' }), requireAiSecret, async (req, res, next) => {
    const { analysisId, conversationId, profileId, cognisys, diagnostic } = req.body || {};
    if (!/^[a-f\d]{24}$/i.test(String(analysisId)) || !isValidId(conversationId) || !isValidId(profileId)) {
        return res.status(400).json({ error: 'invalid payload' });
    }
    const claim = `ai:v2:analysis:${analysisId}`;
    try {
        await redisConnect();
        if (!(await setNxEx(claim, '1', 30 * 86400))) return res.json({ ok: true, duplicate: true });
        const saved = await createCognisysAdapter(cognisysSvc).apply(profileId, cognisys);
        let diagnosticId = null;
        if (diagnostic && !(await getLatestDiagnosticForProfile(profileId))) {
            const d = await createDiagnostic({
                profile: profileId, conversation: conversationId, summary: diagnostic.summary,
                concerns: Array.isArray(diagnostic.concerns) ? diagnostic.concerns : [], recommendation: diagnostic.recommendation,
                creditsAtTrigger: 0,
            });
            diagnosticId = d._id;
            try {
                await createNotification({ profile: profileId, type: NotificationTypes.DIAGNOSTIC_READY, payload: {} });
            } catch (e) {
                console.error('[ai-v2] failed to notify patient of diagnostic:', e?.message);
            }
        }
        return res.json({ ok: true, facts: saved.facts, dimensions: saved.dimensions, diagnosticId });
    } catch (e) {
        await getRedis().del(claim).catch(() => {});        // not saved: let the API deliver it again
        return next(e);
    }
});

export default router;
