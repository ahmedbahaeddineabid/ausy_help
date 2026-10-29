// Callback endpoints for the Auzy AI API (AI v2): the assistant's three lookups and the Cognisys snapshot, served
// by auzy-backend's own services. Mount on the internal network only, together with ai-webhook.route.js:
//   app.use('/internal/ai', aiToolsRoute, aiWebhookRoute);
// Every call must carry the shared secret (AI_V2_CALLBACK_SECRET = the API's AUZY_CALLBACK_SECRET).

import express from 'express';
import mongoose from 'mongoose';
import { findProfiles, findProfileById } from '../services/profile.service.js';
import { listAppointmentsForProfile } from '../services/appointment.service.js';
import agentService from '../services/agent.service.js';
import cognisysSvc from '../services/cognisys.service.js';
import { createCognisysAdapter } from '../lib/ai-v2/cognisys.adapter.js';
import { requireAiSecret } from '../lib/ai-v2/ai-v2.client.js';

const router = express.Router();
const guard = [express.json({ limit: '1mb' }), requireAiSecret];
const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);
const clamp = (n, lo, hi, fallback) => Math.min(hi, Math.max(lo, Number.isFinite(Number(n)) ? Number(n) : fallback));
const searchText = (v) => String(v || '').slice(0, 200);

// Only what the assistant and the cards need leaves auzy-backend: no e-mail, phone or account fields.
// Same lists as the API's src/lib/ai/tools/index.js; adjust both to the real Profile / Appointment / Agent models.
const CONSULTANT_FIELDS = ['_id', 'firstName', 'lastName', 'title', 'speciality', 'specialities', 'specialty', 'specialties',
    'domain', 'languages', 'city', 'gender', 'bio', 'description', 'price', 'consultationPrice', 'currency', 'rating', 'yearsOfExperience'];
const APPOINTMENT_FIELDS = ['_id', 'status', 'startTime', 'endTime', 'start', 'end', 'date', 'scheduledAt', 'type', 'mode',
    'consultant', 'patient', 'price', 'currency'];
const TEST_FIELDS = ['_id', 'name', 'title', 'description', 'category', 'duration', 'questionsCount'];
const PERSON_FIELDS = ['_id', 'firstName', 'lastName', 'name', 'title'];

function pick(doc, fields) {
    const out = {};
    for (const key of fields) {
        const v = doc?.[key];
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) out[key] = v.filter((x) => typeof x !== 'object').slice(0, 10);
        else if (typeof v === 'object' && !(v instanceof Date) && !v._bsontype) out[key] = pick(v, PERSON_FIELDS);   // a populated person
        else out[key] = v;
    }
    return out;
}

router.post('/tools/find-consultants', ...guard, async (req, res, next) => {
    try {
        const out = await findProfiles(
            { role: 'consultant', search: searchText(req.body?.search) },
            { limit: clamp(req.body?.limit, 1, 10, 5), page: 1, sortBy: 'createdAt', sortOrder: 'desc' },
        );
        res.json({ profiles: (out?.profiles || []).map((p) => pick(p, CONSULTANT_FIELDS)) });
    } catch (e) {
        next(e);
    }
});

// The patient's own appointments; the role comes from the profile itself, as in today's chat.
router.post('/tools/appointments', ...guard, async (req, res, next) => {
    try {
        const { profileId, when } = req.body || {};
        if (!isValidId(profileId)) return res.status(400).json({ error: 'invalid profileId' });
        const owner = await findProfileById(profileId);
        if (!owner) return res.json({ appointments: [] });
        const appointments = await listAppointmentsForProfile(profileId, owner.role, {
            when: ['upcoming', 'past'].includes(when) ? when : undefined, limit: clamp(req.body?.limit, 1, 10, 10),
        });
        return res.json({ appointments: (appointments || []).map((a) => pick(a, APPOINTMENT_FIELDS)) });
    } catch (e) {
        return next(e);
    }
});

router.post('/tools/tests', ...guard, async (req, res, next) => {
    try {
        const out = await agentService.publicListAgents({ search: searchText(req.body?.search), limit: clamp(req.body?.limit, 1, 5, 3) });
        res.json({ items: (out?.items || []).map((t) => pick(t, TEST_FIELDS)) });
    } catch (e) {
        next(e);
    }
});

// The stored Cognisys profile, read before each end-of-conversation analysis.
router.get('/cognisys/:profileId', ...guard, async (req, res, next) => {
    try {
        if (!isValidId(req.params.profileId)) return res.status(400).json({ error: 'invalid profileId' });
        return res.json(await createCognisysAdapter(cognisysSvc).getSnapshot(req.params.profileId));
    } catch (e) {
        return next(e);
    }
});

export default router;
