// One patient turn: free safety checks -> pick the model -> reply (with tools) -> escalate if needed.
// Called by the API for POST /v1/messages (server/routes.js).
//
// Escalation = alert to the care team + emergency banner + the careful model (Sonnet) for every later reply.
//   - immediately when the risk service finds a crisis phrase (4 languages: suicidal, self-harm, harming others, abuse)
//   - when the careful model tags its reply <risk>suicidal|self_harm|harm_others|abuse|crisis</risk>
//   - when the routine model declines a turn
// Second opinions: every other signal must be confirmed by the careful model on the same turn before anyone is alerted.
//   - only the risk model flags the message, or the risk service is down: the careful model answers it
//   - the routine model (Haiku) tags its reply as risky: that reply is discarded, the careful model answers the same message
// An escalation stays active for the conversation until a clinician clears it (clearEscalation).
//
// Sessions: the conversation history sent to Claude covers the current session only. The end-of-conversation
// analysis (credits run out, or the chat goes idle) closes the session; the next one starts fresh, seeded with
// the person's Cognisys profile summary and their last few messages, so cost stays bounded.
// A conversation's first turn also carries the greeting the person saw before writing (welcome.js), if any, so the
// reply doesn't greet them twice.

import { systemBlocks, hintMessage } from './prompts/chat.prompt.js';
import { callClaude } from './claude.call.js';
import { cardIds } from './tools/index.js';
import { usageRecord } from './usage.js';
import { emergencyText, guessLanguage } from './safety/emergency.js';
import { fixMixedScript } from './text.js';
import { usesCarefulForRoutine } from './budget.js';

const MAX_SIGNALS = 200;   // per conversation; the analysis only reads the current session's

const FALLBACK_TEXT = {
    en: "I'm sorry, something went wrong on my side. Please try again in a moment.",
    fr: 'Désolé, un problème technique est survenu. Merci de réessayer dans un instant.',
    ar: 'عذرًا، حدث خلل تقني. يرجى المحاولة بعد لحظات.',
    aeb: 'Sma7ni, fama mochkla technique. 3awed jarreb ba3d chwaya.',
};

export function newSession(conversationId, profileId) {
    return {
        conversationId: String(conversationId),
        profileId: profileId ? String(profileId) : null,
        transcript: [],              // API messages of the current session (append-only)
        escalation: { active: false, since: null, reason: null, clearedAt: null, clearedBy: null },
        signals: [],                 // per turn: state, risk score, reasons, model
        turns: 0,                    // turns in the current session
        totalTurns: 0,
        sessionNumber: 1,
        needsAnalysis: false,
        previousContext: null,       // seed for the next session, written by the end-of-conversation analysis
        welcome: null,               // the greeting the person saw before their first message
        language: null,
        lastTurnAt: null,
        costUsd: 0,                  // chat cost of the current session, for the per-conversation ceiling
        totalCostUsd: 0,
    };
}

/**
 * @param policy  budget level holder ({ level() }, see budget.js); decides who writes routine replies
 */
export function createTurnService({ client, config, risk, store, escalate, policy = null, log = console, now = () => new Date() }) {
    const { routine, careful } = config.models;
    const budget = config.budget;
    const level = () => (policy ? policy.level() : budget.startLevel);

    async function escalateNow(session, reason, text, detail = {}) {
        if (session.escalation.active) return false;
        session.escalation = { active: true, since: now().toISOString(), reason, clearedAt: null, clearedBy: null };
        try {
            await escalate({ conversationId: session.conversationId, profileId: session.profileId, reason, message: text,
                language: session.language || 'en', detail });
        } catch (e) {
            log.error?.(`[ai] escalation alert failed for ${session.conversationId}: ${e?.message || e}`);
        }
        return true;
    }

    /** Logs one call and adds its cost to the session; returns the cost. */
    async function logUsage(kind, model, response, session, refused = false) {
        const rec = usageRecord({ kind, model, response, prices: config.prices, refused,
            conversationId: session.conversationId, profileId: session.profileId, session: session.sessionNumber });
        session.costUsd = (session.costUsd || 0) + rec.costUsd;
        session.totalCostUsd = (session.totalCostUsd || 0) + rec.costUsd;
        try {
            await store.logUsage(rec);
        } catch (e) {
            log.warn?.(`[ai] usage log failed: ${e?.message || e}`);
        }
        return rec.costUsd;
    }

    /**
     * @param {object} p
     * @param {string} p.conversationId
     * @param {string} p.profileId
     * @param {object} p.assistant         persona (Assistant document), or null
     * @param {object} p.toolbox           createToolbox(...) bound to this conversation
     * @param {string} p.userText          the patient's new message(s), joined
     * @param {string[]} [p.notes]         chat-setting changes since the last turn (e.g. the language switch)
     * @param {number|null} [p.creditsRemaining]  0 = this was the last message the patient can send for now
     * @param {boolean} [p.freeConsultation]      the patient will be offered a free consultation at 0 credits
     * @returns reply, cards, escalation state and the follow-up jobs to run (urgent_summary / end_analysis)
     */
    async function handleTurn({ conversationId, profileId, assistant, toolbox, userText, notes = [], creditsRemaining = null, freeConsultation = false }) {
        const session = (await store.loadSession(conversationId)) || newSession(conversationId, profileId);
        const wasEscalated = session.escalation.active;
        const guessed = guessLanguage(userText);
        session.language = guessed !== 'en' || !session.language ? guessed : session.language;

        // 1. Free safety checks (crisis phrases + risk model) in the risk service.
        const a = await risk.assess(userText);
        const state = a.model?.state || 'unknown';
        const reasons = [];
        if (a.phrase) reasons.push(`crisis phrase (${a.phrase.category}, ${a.phrase.language})`);
        if (a.model?.risk) reasons.push(`risk model ${a.model.riskScore.toFixed(2)}`);
        if (a.unavailable) reasons.push('safety check unavailable');
        if (a.phrase) await escalateNow(session, reasons[0], userText, { state, riskScore: a.model?.riskScore ?? null });
        const soft = !session.escalation.active && (Boolean(a.model?.risk) || a.unavailable);

        // 2. Build this turn on a copy of the history: only a successful reply is committed.
        const closing = creditsRemaining === 0 ? { escalated: session.escalation.active, freeConsultation } : null;
        const context = session.turns === 0 ? session.previousContext : null;
        const welcome = session.totalTurns === 0 ? session.welcome : null;
        const userMsg = { role: 'user', content: [{ type: 'text', text: userText }] };
        const system = systemBlocks(assistant, config);
        let messages = [...session.transcript, userMsg, hintMessage({ state, reasons, unconfirmed: soft, closing, notes, context, welcome })];

        // Who writes this reply, and how hard it thinks.
        //   escalated                  careful model, its own effort (medium); the ceiling never applies to safety
        //   routine, quality level     careful model at low effort (Arabic/Derja at level 1, everyone at level 2),
        //                              unless the conversation is over its ceiling
        //   second opinion             careful model; at the same effort as the routine replies when those are already
        //                              on the careful model (changing effort would invalidate the cached history)
        //   otherwise                  routine model at low effort
        const overCeiling = (session.costUsd || 0) >= budget.conversationCeilingUsd;
        const qualityRoutine = !overCeiling && usesCarefulForRoutine(level(), session.language, budget);
        let model;
        let effort;
        if (session.escalation.active) [model, effort] = [careful, config.effort[careful]];
        else if (soft) [model, effort] = [careful, qualityRoutine ? config.qualityEffort : config.effort[careful]];
        else if (qualityRoutine) [model, effort] = [careful, config.qualityEffort];
        else [model, effort] = [routine, config.effort[routine]];
        let routineFlag = null;
        let turnCost = 0;

        let result;
        try {
            result = await callClaude({ client, config, model, effort, system, toolbox, messages });
            for (const r of result.responses) turnCost += await logUsage('chat', model, r, session, result.refused);
            if ((result.refused || !result.text) && model === routine) {
                await escalateNow(session, 'routine model declined or returned no text', userText, { state });
                [model, effort] = [careful, config.effort[careful]];
                result = await callClaude({ client, config, model, effort, system, toolbox, messages });
                for (const r of result.responses) turnCost += await logUsage('second_opinion', model, r, session, result.refused);
            } else if (result.riskFlag && model === routine) {
                // The routine model's tag alone never escalates: the careful model answers this same message instead.
                routineFlag = result.riskFlag;
                reasons.push(`first draft flagged ${routineFlag}`);
                messages = [...session.transcript, userMsg, hintMessage({ state, reasons, unconfirmed: true, closing, notes, context, welcome })];
                [model, effort] = [careful, config.effort[careful]];
                result = await callClaude({ client, config, model, effort, system, toolbox, messages });
                for (const r of result.responses) turnCost += await logUsage('second_opinion', model, r, session, result.refused);
            }
        } catch (e) {
            log.error?.(`[ai] Claude call failed for ${conversationId}: ${e?.message || e}`);
            // Keep an escalation or any cost from this turn; the history itself is left untouched.
            if (session.escalation.active !== wasEscalated || turnCost > 0) await store.saveSession(session);
            return {
                reply: FALLBACK_TEXT[session.language] || FALLBACK_TEXT.en, cards: cardIds([]), error: e?.name || 'Error',
                escalated: session.escalation.active, emergencyText: session.escalation.active ? emergencyText(session.language, config.emergencyNumber) : null,
                model: null, state, riskFlag: null, jobs: session.escalation.active && !wasEscalated ? ['urgent_summary'] : [],
                costUsd: turnCost, conversationCostUsd: session.costUsd,
            };
        }

        let reply;
        let appended;
        let cards;
        if (result.refused || !result.text) {
            // Both models declined: never leave a possibly at-risk person without an answer.
            await escalateNow(session, 'careful model declined or returned no text', userText, { state });
            reply = emergencyText(session.language, config.emergencyNumber);
            appended = [{ role: 'assistant', content: [{ type: 'text', text: `${reply}\n<risk>crisis</risk>` }] }];
            cards = cardIds([]);
        } else {
            reply = fixMixedScript(result.text);           // display only: the stored history keeps Claude's output
            appended = result.appended;
            cards = cardIds(result.toolResults);
            if (result.riskFlag && model === careful) {
                const why = routineFlag ? `routine model flagged ${routineFlag}, confirmed by careful model (${result.riskFlag})`
                    : soft ? `${reasons.filter((r) => !r.startsWith('first draft')).join('; ')}, confirmed by careful model (${result.riskFlag})`
                        : `careful model flagged ${result.riskFlag}`;
                await escalateNow(session, why, userText, { state, riskScore: a.model?.riskScore ?? null });
            }
        }

        // 3. Commit the turn.
        session.transcript = [...messages, ...appended];
        session.turns += 1;
        session.totalTurns += 1;
        session.needsAnalysis = true;
        session.lastTurnAt = now().toISOString();
        const confirmed = Boolean(result.riskFlag) && model === careful;
        session.signals = [...session.signals.slice(-(MAX_SIGNALS - 1)), {
            turn: session.totalTurns, at: session.lastTurnAt, state, riskScore: a.model?.riskScore ?? null, model,
            reasons: reasons.map((r) => (r.startsWith('crisis phrase') ? r : `${r} (${confirmed ? 'confirmed' : 'not confirmed'})`)),
            riskFlag: model === careful ? result.riskFlag || null : null,
        }];
        await store.saveSession(session);

        const jobs = [];
        if (session.escalation.active && !wasEscalated) jobs.push('urgent_summary');
        if (creditsRemaining === 0) jobs.push('end_analysis');
        return {
            reply, cards, model, effort, state, riskFlag: result.riskFlag || null,
            escalated: session.escalation.active,
            emergencyText: session.escalation.active ? emergencyText(session.language, config.emergencyNumber) : null,
            language: session.language, jobs, costUsd: turnCost, conversationCostUsd: session.costUsd,
        };
    }

    /** A clinician has followed up: later replies go back to the routine model. */
    async function clearEscalation(conversationId, clearedBy) {
        const session = await store.loadSession(conversationId);
        if (!session || !session.escalation.active) return false;
        session.escalation = { ...session.escalation, active: false, clearedAt: now().toISOString(), clearedBy: clearedBy ? String(clearedBy) : null };
        await store.saveSession(session);
        return true;
    }

    return { handleTurn, clearEscalation };
}
