// Conversation lock, idle detection and the end-of-conversation analysis.
// Replaces cognisys_analysis.queue.js + cognisys_analysis.scheduler.js (which re-analysed the profile
// ~10 seconds after almost every reply) and the direct maybeTriggerDiagnostic call in chat.route.js.
// Load this module once at startup, where cognisys_analysis.scheduler.js used to be imported.

import { redisConnect, setNxEx, getRedis } from '../config/redis.config.js';
import { Profile } from '../model/Profile.js';
import { getConversationByIdPopulated } from '../services/chat.service.js';
import assistantService from '../services/assistant.service.js';
import { createDiagnostic, getLatestDiagnosticForProfile } from '../services/diagnostic.service.js';
import { createNotification } from '../factories/notification.factory.js';
import { NotificationTypes } from '../enums/notification.enums.js';
import { getAi, setConversationLock } from '../lib/ai/index.js';
import { nextLevel, LEVELS } from '../lib/ai/budget.js';
import { measureAverageCost } from '../lib/ai/budget.mongo.js';

const IDLE_ZSET = 'ai:session:idle';
const LOCK_TTL_SECONDS = 300;            // longer than the slowest turn (careful model + tool calls)
const POLL_MS = Number(process.env.AI_IDLE_POLL_MS || 60000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One turn (or session close) at a time per conversation, across every worker. */
export async function withConversationLock(conversationId, fn, { waitMs = 90000 } = {}) {
    await redisConnect();
    const key = `ai:lock:${conversationId}`;
    const deadline = Date.now() + waitMs;
    while (!(await setNxEx(key, '1', LOCK_TTL_SECONDS))) {
        if (Date.now() > deadline) throw new Error(`[ai] lock timeout for conversation ${conversationId}`);
        await sleep(250);
    }
    try {
        return await fn();
    } finally {
        await getRedis().del(key).catch(() => {});
    }
}
setConversationLock(withConversationLock);

/** Same eligibility as v1's maybeTriggerDiagnostic: 0 credits, eligible, no pre-diagnostic yet. */
export async function isDiagnosticDue(profileId) {
    const profile = await Profile.findById(profileId).select('freeConsultationEligible credits');
    if (!profile || profile.freeConsultationEligible === false || profile.credits > 0) return false;
    return !(await getLatestDiagnosticForProfile(profileId));
}

/** (Re)start the idle timer after each turn: no new message for AI_IDLE_MINUTES -> end-of-conversation analysis. */
export async function scheduleIdleAnalysis(conversationId) {
    await redisConnect();
    const due = Date.now() + getAi().config.idleMinutes * 60000;
    await getRedis().zAdd(IDLE_ZSET, [{ score: due, value: String(conversationId) }]);
}

/**
 * One analysis -> Cognisys update + clinician summary (+ pre-diagnostic when due). The Claude call runs without
 * the conversation lock (it can take a minute); a short-lived claim stops two analyses of the same conversation.
 */
export async function runEndAnalysis(conversationId, trigger) {
    await redisConnect();
    const claim = `ai:analysis:running:${conversationId}`;
    if (!(await setNxEx(claim, '1', 600))) return null;
    try {
        const ai = getAi();
        const session = await ai.store.loadSession(conversationId);
        if (!session?.needsAnalysis) return null;
        const includeDiagnostic = await isDiagnosticDue(session.profileId);
        const convo = await getConversationByIdPopulated(conversationId);
        const assistant = convo?.currentAssistant || await assistantService.getGlobalDefaultAssistant();
        const out = await ai.analysis.endAnalysis({ conversationId, trigger, includeDiagnostic, freeConsultation: includeDiagnostic, assistant });
        if (out?.diagnostic) {
            await createDiagnostic({
                profile: session.profileId, conversation: conversationId,
                summary: out.diagnostic.summary, concerns: out.diagnostic.concerns || [], recommendation: out.diagnostic.recommendation,
                creditsAtTrigger: 0,
            });
            try {
                await createNotification({ profile: session.profileId, type: NotificationTypes.DIAGNOSTIC_READY, payload: {} });
            } catch (e) {
                console.error('[ai] failed to notify patient of diagnostic:', e?.message);
            }
        }
        return out;
    } finally {
        await getRedis().del(claim).catch(() => {});
    }
}

export async function pollIdleSessions() {
    try {
        await redisConnect();
        const client = getRedis();
        const due = await client.zRangeByScore(IDLE_ZSET, 0, Date.now(), { LIMIT: { offset: 0, count: 20 } });
        for (const conversationId of due || []) {
            if ((await client.zRem(IDLE_ZSET, conversationId)) !== 1) continue;      // another worker took it
            runEndAnalysis(conversationId, 'idle').catch(async (e) => {
                console.error(`[ai] end analysis failed for ${conversationId}:`, e?.message || e);
                await client.zAdd(IDLE_ZSET, [{ score: Date.now() + 10 * 60000, value: conversationId }]).catch(() => {});   // retry in 10 min
            });
        }
    } catch (e) {
        console.warn('[ai] idle poll error:', e?.message || e);
    }
}

// ---------------------------------------------------------------- budget governor
// Once a day (one worker, via a Redis claim): measure the average cost of finished conversations over the last
// AI_BUDGET_WINDOW_DAYS and move the quality level to stay inside $50-80 per 1,000. Every worker reads the
// shared level every 5 minutes.

const LEVEL_KEY = 'ai:budget:level';
const LEVEL_CHANGED_KEY = 'ai:budget:level_changed_at';
const DAY_MS = 86400000;

export async function runBudgetGovernor() {
    try {
        await redisConnect();
        const client = getRedis();
        if (!(await setNxEx('ai:budget:governor', '1', 23 * 3600))) return null;      // already decided today
        const ai = getAi();
        const stored = await client.get(LEVEL_KEY);
        const current = stored !== null ? Number(stored) : ai.budget.level();
        const changedAt = Number(await client.get(LEVEL_CHANGED_KEY)) || 0;
        const { avgUsd, samples } = await measureAverageCost(ai.config.budget.windowDays);
        const next = nextLevel({ current, avgUsd, samples, daysSinceChange: (Date.now() - changedAt) / DAY_MS, budget: ai.config.budget });
        const per1000 = avgUsd == null ? 'n/a' : `$${(avgUsd * 1000).toFixed(0)}`;
        if (next !== current) {
            await client.set(LEVEL_CHANGED_KEY, String(Date.now()));
            console.warn(`[ai] budget: ${per1000} per 1,000 over ${samples} conversations -> quality level ${LEVELS[current]} -> ${LEVELS[next]}`);
        } else {
            console.log(`[ai] budget: ${per1000} per 1,000 over ${samples} conversations, level stays ${LEVELS[current]}`);
        }
        await client.set(LEVEL_KEY, String(next));
        ai.budget.set(next);
        return { avgUsd, samples, level: next };
    } catch (e) {
        console.warn('[ai] budget governor error:', e?.message || e);
        return null;
    }
}

export async function refreshBudgetLevel() {
    try {
        await redisConnect();
        const stored = await getRedis().get(LEVEL_KEY);
        if (stored !== null) getAi().budget.set(Number(stored));
    } catch (e) {
        console.warn('[ai] budget level refresh error:', e?.message || e);
    }
}

if (process.env.NODE_ENV !== 'test') {
    setInterval(pollIdleSessions, POLL_MS);
    pollIdleSessions();
    setInterval(runBudgetGovernor, 3600000);            // the Redis claim makes it run once a day
    setInterval(refreshBudgetLevel, 5 * 60000);
    refreshBudgetLevel();
}
