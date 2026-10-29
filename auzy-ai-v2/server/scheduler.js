// Background work of the API, in this process (the API's version of in-backend-option/src/queues/ai_session.scheduler.js,
// without Redis):
//   - end-of-conversation analysis: right away when credits reach 0, or once a conversation has had no message for
//     AI_IDLE_MINUTES. Idle conversations are found by polling the store, so a restart loses nothing.
//     A failed analysis is retried with a growing delay, at most MAX_ANALYSIS_FAILURES times per idle period.
//   - delivery of each analysis to auzy-backend (Cognisys update, clinician summary, pre-diagnostic), retried until it
//     is accepted; every attempt carries the same analysisId, so auzy-backend can ignore repeats.
//   - the budget governor, once a day (src/lib/ai/budget.js#nextLevel); the level is kept in the store.

import { nextLevel, LEVELS } from '../src/lib/ai/budget.js';

const DAY_MS = 86400000;
const MAX_ANALYSIS_FAILURES = 5;
const MAX_DELIVERY_ATTEMPTS = 12;                 // about 8 hours of retries
const BATCH = 20;
const backoffMs = (attempt) => Math.min(60, 2 ** attempt) * 60000;    // 2, 4, 8 ... 60 minutes

export function createScheduler({ ai, store, deliver = null, settings, log = console, now = () => new Date() }) {
    const running = new Set();          // conversations whose analysis is running
    const delivering = new Set();       // analyses being delivered
    const failures = new Map();         // conversationId -> { count, lastTurnAt, retryAt }
    const inflight = new Set();         // background promises, awaited on shutdown
    let timers = [];

    function track(promise) {
        inflight.add(promise);
        const done = () => inflight.delete(promise);
        promise.then(done, done);
        return promise;
    }

    async function deliverOne(id) {
        if (!deliver || delivering.has(id)) return null;
        delivering.add(id);
        try {
            const a = await store.getAnalysis(id);
            if (!a || a.delivery !== 'pending') return a?.delivery || null;
            const attempts = a.attempts + 1;
            try {
                await deliver({
                    analysisId: a.id, conversationId: a.conversationId, profileId: a.profileId, trigger: a.trigger, model: a.model,
                    createdAt: a.createdAt, ...a.result,
                });
                await store.updateAnalysis(id, { delivery: 'delivered', attempts, deliveredAt: now(), lastError: null });
                return 'delivered';
            } catch (e) {
                const gaveUp = attempts >= MAX_DELIVERY_ATTEMPTS;
                await store.updateAnalysis(id, {
                    delivery: gaveUp ? 'failed' : 'pending', attempts, lastError: String(e?.message || e).slice(0, 300),
                    nextAttemptAt: new Date(now().getTime() + backoffMs(attempts)),
                });
                const msg = `[api] analysis ${id} not delivered to auzy-backend (attempt ${attempts}${gaveUp ? ', giving up' : ''}): ${e?.message || e}`;
                if (gaveUp) log.error?.(msg);
                else log.warn?.(msg);
                return gaveUp ? 'failed' : 'pending';
            }
        } finally {
            delivering.delete(id);
        }
    }

    /**
     * Runs the end-of-conversation analysis, keeps it, and delivers it to auzy-backend.
     * -> { status: 'done' | 'running' | 'nothing_to_analyse', analysisId?, delivery?, analysis? }; throws on failure.
     */
    async function runEndAnalysis(conversationId, trigger) {
        if (running.has(conversationId)) return { status: 'running' };
        running.add(conversationId);
        try {
            const info = (await store.loadConversationInfo(conversationId)) || {};
            const session = await store.loadSession(conversationId);
            // Same rule as v1's maybeTriggerDiagnostic: 0 credits and eligible (auzy-backend checks there is none yet).
            const includeDiagnostic = info.creditsRemaining === 0 && Boolean(info.freeConsultationEligible);
            const why = trigger || (info.creditsRemaining === 0 ? 'credits_exhausted' : 'idle');
            let out;
            try {
                out = await ai.analysis.endAnalysis({
                    conversationId, trigger: why, includeDiagnostic, freeConsultation: includeDiagnostic, assistant: info.persona || null,
                });
            } catch (e) {
                const f = failures.get(conversationId);
                const count = f && f.lastTurnAt === session?.lastTurnAt ? f.count + 1 : 1;
                failures.set(conversationId, { count, lastTurnAt: session?.lastTurnAt, retryAt: now().getTime() + backoffMs(count) });
                if (count >= MAX_ANALYSIS_FAILURES) {
                    log.error?.(`[api] end analysis for ${conversationId} failed ${count} times; next try after the patient writes again`);
                }
                throw e;
            }
            failures.delete(conversationId);
            if (!out) return { status: 'nothing_to_analyse' };
            const delivery = deliver ? 'pending' : 'none';
            const analysisId = await store.saveAnalysis({
                conversationId, profileId: session?.profileId || info.profileId || null, trigger: why, model: out.model,
                result: { cognisys: out.cognisys, clinicianSummary: out.clinicianSummary, diagnostic: out.diagnostic },
                delivery, attempts: 0, nextAttemptAt: now(),
            });
            return { status: 'done', analysisId, delivery: deliver ? await deliverOne(analysisId) : delivery, analysis: out };
        } finally {
            running.delete(conversationId);
        }
    }

    async function pollOnce() {
        const before = new Date(now().getTime() - ai.config.idleMinutes * 60000);
        for (const { conversationId, lastTurnAt } of await store.dueForAnalysis(before, BATCH)) {
            const f = failures.get(conversationId);
            if (running.has(conversationId) || (f && f.lastTurnAt === lastTurnAt && (f.count >= MAX_ANALYSIS_FAILURES || f.retryAt > now().getTime()))) continue;
            track(runEndAnalysis(conversationId, null).catch((e) => log.error?.(`[api] end analysis failed for ${conversationId}: ${e?.message || e}`)));
        }
        if (deliver) {
            for (const id of await store.analysesToDeliver(now(), BATCH)) track(deliverOne(id));
        }
    }

    /** Once a day: move the quality level to keep the measured cost per 1,000 conversations inside the band. */
    async function governOnce() {
        const state = (await store.getSetting('budget')) || {};
        if (state.decidedAt && now().getTime() - new Date(state.decidedAt).getTime() < 23 * 3600000) return null;
        const current = Number.isInteger(state.level) ? state.level : ai.budget.level();
        const { avgUsd, samples } = await store.measureAverageCost(ai.config.budget.windowDays);
        const changedAt = state.changedAt ? new Date(state.changedAt).getTime() : 0;
        const next = nextLevel({ current, avgUsd, samples, daysSinceChange: (now().getTime() - changedAt) / DAY_MS, budget: ai.config.budget });
        const per1000 = avgUsd == null ? 'n/a' : `$${(avgUsd * 1000).toFixed(0)}`;
        if (next !== current) log.warn?.(`[api] budget: ${per1000} per 1,000 over ${samples} conversations -> quality level ${LEVELS[current]} -> ${LEVELS[next]}`);
        else log.log?.(`[api] budget: ${per1000} per 1,000 over ${samples} conversations, level stays ${LEVELS[current]}`);
        await store.setSetting('budget', {
            level: next, changedAt: next !== current ? now().toISOString() : state.changedAt || null,
            decidedAt: now().toISOString(), avgUsd, samples,
        });
        ai.budget.set(next);
        return { level: next, avgUsd, samples };
    }

    async function restoreBudgetLevel() {
        const state = await store.getSetting('budget');
        if (Number.isInteger(state?.level)) ai.budget.set(state.level);
    }

    function start() {
        const safely = (name, fn) => () => fn().catch((e) => log.warn?.(`[api] ${name} error: ${e?.message || e}`));
        const poll = safely('poll', pollOnce);
        const govern = safely('budget governor', governOnce);
        safely('budget level restore', restoreBudgetLevel)().then(govern);
        poll();
        timers = [setInterval(poll, settings.pollMs), setInterval(govern, 3600000)];
    }

    /** Resolves once no background work is left (work started meanwhile included). */
    async function settled() {
        while (inflight.size) await Promise.allSettled([...inflight]);
    }

    /** Stops the timers and waits (up to graceMs) for analyses, summaries and deliveries already started. */
    async function stop(graceMs = 30000) {
        timers.forEach(clearInterval);
        timers = [];
        let timer;
        await Promise.race([settled(), new Promise((r) => { timer = setTimeout(r, graceMs); })]);
        clearTimeout(timer);
    }

    return { runEndAnalysis, deliverOne, pollOnce, governOnce, restoreBudgetLevel, start, stop, settled, track, isRunning: (id) => running.has(id) };
}
