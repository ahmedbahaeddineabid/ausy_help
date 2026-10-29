// Staff endpoints for AI v2. Mount with: app.use('/api/v1/ai', aiRoute)
// Access: only profiles whose role is listed in AI_STAFF_ROLES (comma-separated). Empty = nobody, on purpose:
// these endpoints expose health information. Tighten further (e.g. a consultant only sees their own patients)
// before opening them to consultants.

import express from 'express';
import mongoose from 'mongoose';
import { extractUserToken, extractProfileToken, requireProfile } from '../middleware/auth.middleware.js';
import { ClinicianSummary } from '../model/ClinicianSummary.js';
import { AiUsage } from '../model/AiUsage.js';
import { AiSession } from '../model/AiSession.js';
import { getAi } from '../lib/ai/index.js';
import { measureAverageCost } from '../lib/ai/budget.mongo.js';

const router = express.Router();
const auth = [extractUserToken, extractProfileToken, requireProfile];
const staffRoles = () => (process.env.AI_STAFF_ROLES || '').split(',').map((r) => r.trim()).filter(Boolean);
const requireStaff = (req, res, next) => (staffRoles().includes(req.profile?.role) ? next() : res.status(403).json({ error: 'Forbidden' }));
const isValidId = (v) => mongoose.Types.ObjectId.isValid(v);

// GET /api/v1/ai/summaries?urgent=true&limit=50 -> latest summaries, urgent first
router.get('/summaries', ...auth, requireStaff, async (req, res, next) => {
    try {
        const filter = req.query.urgent === 'true' ? { urgent: true } : {};
        const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
        const items = await ClinicianSummary.find(filter).sort({ urgent: -1, createdAt: -1 }).limit(limit).lean();
        res.json({ items });
    } catch (e) { next(e); }
});

// GET /api/v1/ai/conversations/:id -> escalation state + every summary of one conversation
router.get('/conversations/:id', ...auth, requireStaff, async (req, res, next) => {
    try {
        if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid conversation id' });
        const [session, summaries] = await Promise.all([
            AiSession.findOne({ conversation: req.params.id }).select('escalation signals sessionNumber totalTurns lastTurnAt').lean(),
            ClinicianSummary.find({ conversation: req.params.id }).sort({ createdAt: -1 }).lean(),
        ]);
        res.json({ escalation: session?.escalation || { active: false }, signals: session?.signals || [], summaries });
    } catch (e) { next(e); }
});

// POST /api/v1/ai/conversations/:id/clear-escalation -> a clinician has followed up; replies go back to the routine model
router.post('/conversations/:id/clear-escalation', ...auth, requireStaff, async (req, res, next) => {
    try {
        if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid conversation id' });
        const cleared = await getAi().turns.clearEscalation(req.params.id, req.profile._id);
        res.json({ cleared });
    } catch (e) { next(e); }
});

// GET /api/v1/ai/costs?days=30 -> spend by kind and model, and per conversation
router.get('/costs', ...auth, requireStaff, async (req, res, next) => {
    try {
        const since = new Date(Date.now() - Math.min(365, Math.max(1, Number(req.query.days) || 30)) * 86400000);
        const [byKind, totals] = await Promise.all([
            AiUsage.aggregate([
                { $match: { createdAt: { $gte: since } } },
                { $group: { _id: { kind: '$kind', model: '$model' }, calls: { $sum: 1 }, usd: { $sum: '$costUsd' },
                    input: { $sum: '$input' }, cacheRead: { $sum: '$cacheRead' }, cacheWrite: { $sum: '$cacheWrite' }, output: { $sum: '$output' } } },
                { $sort: { usd: -1 } },
            ]),
            AiUsage.aggregate([
                { $match: { createdAt: { $gte: since } } },
                { $group: { _id: null, usd: { $sum: '$costUsd' }, conversations: { $addToSet: '$conversation' } } },
            ]),
        ]);
        const t = totals[0] || { usd: 0, conversations: [] };
        const ai = getAi();
        const finished = await measureAverageCost(Math.min(365, Math.max(1, Number(req.query.days) || 30)));
        res.json({
            since, totalUsd: t.usd, conversations: t.conversations.length,
            perConversationUsd: t.conversations.length ? t.usd / t.conversations.length : 0,
            // Finished conversations (one sitting each) and the budget band the governor keeps them in.
            finishedConversations: finished.samples,
            per1000FinishedUsd: finished.avgUsd == null ? null : finished.avgUsd * 1000,
            mostExpensiveConversationUsd: finished.maxUsd,
            budget: { level: ai.budget.name(), targetPer1000Usd: [ai.config.budget.targetMinPer1000Usd, ai.config.budget.targetMaxPer1000Usd],
                conversationCeilingUsd: ai.config.budget.conversationCeilingUsd },
            byKindAndModel: byKind.map((r) => ({ ...r._id, calls: r.calls, usd: r.usd,
                cacheHitShare: (r.cacheRead + r.input + r.cacheWrite) ? r.cacheRead / (r.cacheRead + r.input + r.cacheWrite) : 0, outputTokens: r.output })),
        });
    } catch (e) { next(e); }
});

export default router;
