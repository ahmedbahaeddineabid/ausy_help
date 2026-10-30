// HTTP API v1 (see openapi.yaml). JSON in and out; errors are { error, message? }.
//   service key (AUZY_AI_API_KEY): GET /v1/welcome, POST /v1/messages, POST /v1/conversations/:id/end
//   staff token (AUZY_AI_STAFF_TOKEN): conversation state, clear escalation, summaries, costs (and /end)
//   no key: GET /v1/health
// Patient text is never logged.

import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createToolbox } from '../src/lib/ai/tools/index.js';
import { newSession } from '../src/lib/ai/turn.service.js';
import { welcomeText, WELCOME_LANGUAGES } from '../src/lib/ai/welcome.js';

const OBJECT_ID = /^[a-f\d]{24}$/i;
const DAY_MS = 86400000;

class BadRequest extends Error {}

const digest = (s) => createHash('sha256').update(String(s)).digest();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const clampInt = (v, lo, hi, fallback) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

function readId(v, name) {
    if (typeof v !== 'string' || !OBJECT_ID.test(v)) throw new BadRequest(`${name} must be a 24-character hexadecimal id`);
    return v.toLowerCase();
}

function readStrings(v, name, maxItems, maxLength) {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new BadRequest(`${name} must be an array of strings`);
    return v.map((x) => x.trim()).filter(Boolean).slice(0, maxItems).map((x) => x.slice(0, maxLength));
}

/** Persona (Auzy's Assistant document): only the fields the prompt uses, in a fixed order so the cached prompt stays identical. */
function readPersona(p) {
    if (p === undefined || p === null) return null;
    if (typeof p !== 'object' || Array.isArray(p)) throw new BadRequest('persona must be an object or null');
    const text = (key, max) => {
        const v = p[key];
        if (v === undefined || v === null || v === '') return undefined;
        if (typeof v !== 'string') throw new BadRequest(`persona.${key} must be a string`);
        return v.trim().slice(0, max);
    };
    const out = { name: text('name', 120), description: text('description', 1000), domain: text('domain', 100), behavior: text('behavior', 300) };
    if (p.rules !== undefined && p.rules !== null) out.rules = readStrings(p.rules, 'persona.rules', 30, 500);
    if (p.personalization !== undefined && p.personalization !== null) {
        const size = (typeof p.personalization === 'string' ? p.personalization : JSON.stringify(p.personalization)).length;
        if (size > 2000) throw new BadRequest('persona.personalization is longer than 2000 characters');
        out.personalization = p.personalization;
    }
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

function readHistory(h) {
    if (h === undefined || h === null) return [];
    if (!Array.isArray(h)) throw new BadRequest('history must be an array');
    return h.slice(-50)
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .map((m) => ({ role: m.role, content: m.content.trim().slice(0, 4000) }));
}

function readTurn(b, maxText) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new BadRequest('the body must be a JSON object');
    const conversationId = readId(b.conversationId, 'conversationId');
    const profileId = readId(b.profileId, 'profileId');
    if (typeof b.text !== 'string' || !b.text.trim()) throw new BadRequest('text must be a non-empty string');
    const text = b.text.trim();
    if (text.length > maxText) throw new BadRequest(`text is longer than ${maxText} characters`);
    let creditsRemaining = null;
    if (b.creditsRemaining !== undefined && b.creditsRemaining !== null) {
        if (!Number.isInteger(b.creditsRemaining) || b.creditsRemaining < 0) throw new BadRequest('creditsRemaining must be a whole number from 0, or null');
        creditsRemaining = b.creditsRemaining;
    }
    if (b.freeConsultationEligible !== undefined && typeof b.freeConsultationEligible !== 'boolean') {
        throw new BadRequest('freeConsultationEligible must be true or false');
    }
    return {
        conversationId, profileId, text, creditsRemaining,
        freeConsultationEligible: b.freeConsultationEligible === true,
        notes: readStrings(b.notes, 'notes', 10, 500),
        persona: readPersona(b.persona),
        history: readHistory(b.history),
    };
}

export function createRoutes({ ai, store, scheduler, auzy, settings, withLock, checkRisk = async () => null, log = console, now = () => new Date(), version = '' }) {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '256kb' }));
    app.use((req, res, next) => {
        const start = Date.now();
        if (req.path !== '/v1/health') res.on('finish', () => log.info?.(`[api] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`));
        next();
    });

    /** Bearer token check, constant-time; a route accepts any of the given secrets that is configured. */
    const requireToken = (secrets, what) => (req, res, next) => {
        const configured = secrets.filter(Boolean);
        if (!configured.length) return res.status(403).json({ error: 'forbidden', message: `${what} access is not configured on this server` });
        const header = req.get('authorization') || '';
        const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
        if (!token || !configured.some((s) => timingSafeEqual(digest(token), digest(s)))) return res.status(401).json({ error: 'unauthorized' });
        return next();
    };
    const service = requireToken([settings.apiKey], 'Service');
    const staff = requireToken([settings.staffToken], 'Staff');
    const serviceOrStaff = requireToken([settings.apiKey, settings.staffToken], 'Service');

    /**
     * First message handled here for a conversation: the greeting the patient saw (assistant messages only), or, for a
     * conversation that started on the old chat, its last messages.
     */
    async function seedFromHistory(m) {
        if (await store.loadSession(m.conversationId)) return;
        if (!m.history.some((h) => h.role === 'user')) {
            await store.saveSession({ ...newSession(m.conversationId, m.profileId), welcome: m.history.map((h) => h.content).join('\n\n') });
            return;
        }
        let summary = null;
        try {
            summary = (await auzy.cognisys.getSnapshot(m.profileId))?.profile?.summary || null;
        } catch (e) {
            log.warn?.(`[api] Cognisys snapshot unavailable for the first turn of ${m.conversationId}: ${e?.message || e}`);
        }
        const recent = m.history.slice(-ai.config.contextMessages).map((h) => `${h.role === 'user' ? 'PATIENT' : 'ASSISTANT'}: ${h.content}`).join('\n');
        await store.saveSession({
            ...newSession(m.conversationId, m.profileId),
            previousContext: `Profile summary: ${summary && summary !== 'Pending summary' ? summary : 'none'}\nLast messages:\n${recent}`,
        });
    }

    // The greeting that opens an empty conversation: fixed text, no Claude call. The client shows it, then sends it as
    // `history` with the patient's first message, so the first reply doesn't greet them again.
    app.get('/v1/welcome', service, wrap(async (req, res) => {
        const { language = 'en', name = '' } = req.query;
        if (!WELCOME_LANGUAGES.includes(language)) throw new BadRequest(`language must be one of ${WELCOME_LANGUAGES.join(', ')}`);
        if (typeof name !== 'string') throw new BadRequest('name must be a string');
        res.json({ text: welcomeText(language, name.trim().slice(0, 120)), language });
    }));

    app.post('/v1/messages', service, wrap(async (req, res) => {
        const m = readTurn(req.body, settings.maxTextChars);
        const result = await withLock(m.conversationId, async () => {
            if (m.history.length) await seedFromHistory(m);
            // Appointments are looked up for this profile only; auzy-backend checks its role itself.
            const toolbox = createToolbox({ services: auzy.services, profileId: m.profileId, role: null });
            const r = await ai.turns.handleTurn({
                conversationId: m.conversationId, profileId: m.profileId, assistant: m.persona, toolbox,
                userText: m.text, notes: m.notes, creditsRemaining: m.creditsRemaining,
                freeConsultation: m.creditsRemaining === 0 && m.freeConsultationEligible,
            });
            await store.saveConversationInfo(m.conversationId, {
                profileId: m.profileId, creditsRemaining: m.creditsRemaining, freeConsultationEligible: m.freeConsultationEligible,
                persona: m.persona ? { name: m.persona.name, domain: m.persona.domain, description: m.persona.description } : null,
            });
            return r;
        });

        // After the reply: the urgent summary first (it needs the session before the analysis closes it), then the
        // end-of-conversation analysis at 0 credits. A failed analysis is retried by the idle poll.
        if (result.jobs.length) {
            scheduler.track((async () => {
                if (result.jobs.includes('urgent_summary')) {
                    await ai.analysis.urgentSummary(m.conversationId)
                        .catch((e) => log.error?.(`[api] urgent summary failed for ${m.conversationId}: ${e?.message || e}`));
                }
                if (result.jobs.includes('end_analysis')) {
                    await scheduler.runEndAnalysis(m.conversationId, 'credits_exhausted')
                        .catch((e) => log.error?.(`[api] end analysis failed for ${m.conversationId}, the idle poll will retry: ${e?.message || e}`));
                }
            })());
        }

        res.json({
            reply: result.reply, cards: result.cards, escalated: result.escalated, emergencyText: result.emergencyText,
            model: result.model, state: result.state, riskFlag: result.riskFlag, language: result.language ?? null,
            costUsd: result.costUsd, conversationCostUsd: result.conversationCostUsd, followUp: result.jobs, error: result.error || null,
        });
    }));

    app.post('/v1/conversations/:id/end', serviceOrStaff, wrap(async (req, res) => {
        const id = readId(req.params.id, 'conversation id');
        let out;
        try {
            out = await scheduler.runEndAnalysis(id, null);
        } catch (e) {
            log.error?.(`[api] end analysis failed for ${id}: ${e?.message || e}`);
            return res.status(502).json({ error: 'analysis_failed', message: 'The analysis could not be completed; it is retried automatically.' });
        }
        if (out.status === 'running') return res.status(409).json({ error: 'analysis_running', message: 'An analysis of this conversation is already running.' });
        if (out.status === 'nothing_to_analyse') return res.json({ status: 'nothing_to_analyse' });
        const a = out.analysis;
        return res.json({
            status: 'done', analysisId: out.analysisId, delivery: out.delivery, model: a.model,
            clinicianSummary: a.clinicianSummary, cognisys: a.cognisys, diagnostic: a.diagnostic,
        });
    }));

    app.get('/v1/conversations/:id', staff, wrap(async (req, res) => {
        const id = readId(req.params.id, 'conversation id');
        const [session, summaries, analyses] = await Promise.all([
            store.loadSession(id), store.listSummaries({ conversationId: id, limit: 50 }), store.listAnalyses(id, 20),
        ]);
        if (!session && !summaries.length && !analyses.length) return res.status(404).json({ error: 'not_found' });
        const s = session || {};
        return res.json({
            conversationId: id, profileId: s.profileId ?? null,
            escalation: s.escalation || { active: false },
            language: s.language ?? null, sessionNumber: s.sessionNumber ?? null, turnsThisSession: s.turns ?? 0, totalTurns: s.totalTurns ?? 0,
            needsAnalysis: Boolean(s.needsAnalysis), analysisRunning: scheduler.isRunning(id),
            lastTurnAt: s.lastTurnAt ?? null, lastAnalysisAt: s.lastAnalysisAt ?? null,
            sessionCostUsd: s.costUsd ?? 0, totalCostUsd: s.totalCostUsd ?? 0,
            signals: s.signals || [],
            summaries,
            analyses,
        });
    }));

    app.post('/v1/conversations/:id/clear-escalation', staff, wrap(async (req, res) => {
        const id = readId(req.params.id, 'conversation id');
        const by = req.body?.clearedBy;
        const clearedBy = by === undefined || by === null ? null : readId(by, 'clearedBy');
        const cleared = await withLock(id, () => ai.turns.clearEscalation(id, clearedBy));
        res.json({ cleared });
    }));

    app.get('/v1/summaries', staff, wrap(async (req, res) => {
        const items = await store.listSummaries({ urgent: req.query.urgent === 'true', limit: clampInt(req.query.limit, 1, 200, 50) });
        res.json({ items });
    }));

    app.get('/v1/costs', staff, wrap(async (req, res) => {
        const days = clampInt(req.query.days, 1, 365, 30);
        const since = new Date(now().getTime() - days * DAY_MS);
        const [t, finished] = await Promise.all([store.usageTotals(since), store.measureAverageCost(days)]);
        const b = ai.config.budget;
        res.json({
            since, days, totalUsd: t.totalUsd, conversations: t.conversations,
            perConversationUsd: t.conversations ? t.totalUsd / t.conversations : 0,
            // Finished conversations (one sitting each) and the budget band the governor keeps them in.
            finishedConversations: finished.samples,
            per1000FinishedUsd: finished.avgUsd == null ? null : finished.avgUsd * 1000,
            mostExpensiveConversationUsd: finished.maxUsd,
            budget: { level: ai.budget.name(), targetPer1000Usd: [b.targetMinPer1000Usd, b.targetMaxPer1000Usd], conversationCeilingUsd: b.conversationCeilingUsd },
            byKindAndModel: t.byKindAndModel.map((r) => ({
                kind: r.kind, model: r.model, calls: r.calls, usd: r.usd, outputTokens: r.output,
                cacheHitShare: (r.cacheRead + r.input + r.cacheWrite) ? r.cacheRead / (r.cacheRead + r.input + r.cacheWrite) : 0,
            })),
        });
    }));

    app.get('/v1/health', wrap(async (req, res) => {
        const [storeOk, riskOk] = await Promise.all([store.ping().catch(() => false), checkRisk().catch(() => false)]);
        res.status(storeOk ? 200 : 503).json({
            ok: storeOk, version, store: { kind: store.kind, ok: storeOk },
            // The API keeps answering without the risk service (the careful model answers every message meanwhile).
            riskService: { ok: riskOk }, auzy: auzy.mode, budgetLevel: ai.budget.name(),
        });
    }));

    app.use((req, res) => res.status(404).json({ error: 'not_found' }));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        if (err instanceof BadRequest) return res.status(400).json({ error: 'invalid_request', message: err.message });
        if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
        if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
        log.error?.(`[api] ${req.method} ${req.path} failed: ${err?.stack || err}`);
        return res.status(500).json({ error: 'internal_error' });
    });
    return app;
}
