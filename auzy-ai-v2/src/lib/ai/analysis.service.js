// Urgent clinician summary (the moment a conversation escalates) and the end-of-conversation analysis
// (credits reach 0, or the chat goes idle): one call that returns the Cognisys update, the clinician
// summary and, when due, the patient's pre-diagnostic.
//
// Model: the careful model (Sonnet) for urgent summaries, escalated conversations, and Arabic or Derja
// conversations (the routine model misread Derja in testing); the routine model (Haiku) otherwise.
// A cut-off or invalid result is retried once on the careful model, because a missing clinician
// summary is worse than a second call.

import { analysisSchema, analysisSystem, SUMMARY_SCHEMA, urgentSystem } from './prompts/analysis.prompt.js';
import { stripTags } from './prompts/chat.prompt.js';
import { usageRecord } from './usage.js';
import { hasArabicScript, isArabizi } from './safety/emergency.js';
import { fixMixedScript } from './text.js';

export class AnalysisError extends Error {}

/** Patient and assistant text only: no thinking, tool calls, tool results or screening hints. */
export function transcriptText(transcript = []) {
    const lines = [];
    for (const m of transcript) {
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
        const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
        if (text) lines.push(`${m.role === 'user' ? 'PATIENT' : 'ASSISTANT'}: ${stripTags(text)}`);
    }
    return lines.join('\n');
}

function patientText(transcript) {
    return transcriptText(transcript).split('\n').filter((l) => l.startsWith('PATIENT:')).join('\n');
}

/** Signals of the current session only (earlier sessions are already reflected in the stored profile). */
export function sessionSignals(session) {
    const start = (session.totalTurns || 0) - (session.turns || 0);
    return (session.signals || []).filter((s) => s.turn > start);
}

export function signalsText(signals = []) {
    if (!signals.length) return 'none recorded';
    return signals.map((s) => `- message ${s.turn}: likely state ${s.state}`
        + (s.riskScore != null ? `, risk score ${Number(s.riskScore).toFixed(2)}` : '')
        + (s.reasons?.length ? `, signals: ${s.reasons.join('; ')}` : '')
        + (s.riskFlag ? `, assistant flagged ${s.riskFlag}` : '')).join('\n');
}

/** Compact, read-only view of the stored Cognisys state for the prompt. */
export function compactSnapshot(snapshot) {
    if (!snapshot) return { profile: null, facts: [], dimensions: [], recentAnalyses: [] };
    const p = snapshot.profile || {};
    return {
        profile: p ? { summary: p.summary, tags: p.tags, keyInsights: p.keyInsights, riskFactors: p.riskFactors, opportunities: p.opportunities } : null,
        facts: (snapshot.facts || []).map((f) => ({ category: f.category, key: f.key, value: f.value })),
        dimensions: (snapshot.dimensions || []).map((d) => ({ dimension: d.dimension, score: d.score })),
        recentAnalyses: (snapshot.analyses || []).slice(0, 3).map((x) => ({ type: x.analysisType, summary: x.summary })),
    };
}

export function createAnalysisService({ client, config, store, cognisys, notify = async () => {}, lock = (id, fn) => fn(), log = console, now = () => new Date() }) {
    const { routine, careful } = config.models;

    function pickModel(session) {
        if (session.escalation?.active) return careful;                                  // safety: never limited by the ceiling
        if ((session.costUsd || 0) >= config.budget.conversationCeilingUsd) return routine; // over this conversation's ceiling
        if (['ar', 'aeb'].includes(session.language)) return careful;
        const words = patientText(session.transcript);
        return hasArabicScript(words) || isArabizi(words) ? careful : routine;
    }

    async function request({ model, system, schema, input, session, kind }) {
        const res = await client.messages.create({
            model,
            max_tokens: config.maxTokens.analysis,          // thinking counts toward it: leave room for the JSON
            system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
            thinking: { type: 'adaptive' },
            output_config: { effort: config.effort[model], format: { type: 'json_schema', schema } },
            messages: [{ role: 'user', content: input }],
        }, { timeout: config.analysisTimeoutMs });
        try {
            await store.logUsage(usageRecord({ kind, model, response: res, prices: config.prices, refused: res.stop_reason === 'refusal',
                conversationId: session.conversationId, profileId: session.profileId, session: session.sessionNumber }));
        } catch (e) {
            log.warn?.(`[ai] usage log failed: ${e?.message || e}`);
        }
        if (res.stop_reason === 'refusal') throw new AnalysisError('declined');
        if (res.stop_reason === 'max_tokens') throw new AnalysisError('cut off at max_tokens');
        const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
        try {
            return JSON.parse(text);
        } catch (e) {
            throw new AnalysisError(`invalid JSON: ${e.message}`);
        }
    }

    /** First model, then once more on the careful model if the first answer is unusable. */
    async function withRetry(firstModel, args) {
        const tried = [...new Set([firstModel, careful])];
        let lastError;
        for (const model of tried) {
            try {
                return { data: await request({ ...args, model }), model };
            } catch (e) {
                if (!(e instanceof AnalysisError)) throw e;          // network/API errors: let the caller retry later
                lastError = e;
                log.warn?.(`[ai] ${args.kind} on ${model} failed for ${args.session.conversationId}: ${e.message}`);
            }
        }
        throw lastError;
    }

    function forceUrgent(summary, session) {
        if (session.escalation?.active && !summary.urgent) {
            summary.urgent = true;
            summary.urgency_reason = `${summary.urgency_reason || ''} [escalated by automated checks: ${session.escalation.reason}]`.trim();
        }
        return summary;
    }

    async function urgentSummary(conversationId) {
        const session = await store.loadSession(conversationId);
        if (!session || !session.transcript.length) return null;
        const input = `Why this summary is being written: conversation escalated (${session.escalation?.reason || 'possible risk'}).\n\n`
            + `Automated screening signals per patient message:\n${signalsText(sessionSignals(session))}\n\n`
            + `Conversation:\n${transcriptText(session.transcript)}`;
        const { data, model } = await withRetry(careful, { system: urgentSystem(config), schema: SUMMARY_SCHEMA, input, session, kind: 'urgent_summary' });
        const summary = forceUrgent(data, session);
        await store.saveSummary({ conversationId, profileId: session.profileId, trigger: 'escalation', model, urgent: summary.urgent, summary });
        await notify({ type: 'clinician_summary', conversationId, profileId: session.profileId, trigger: 'escalation', urgent: summary.urgent, summary });
        return summary;
    }

    /**
     * @param {object} p
     * @param {string} p.trigger                 'credits_exhausted' | 'idle'
     * @param {boolean} [p.includeDiagnostic]    produce the patient's pre-diagnostic (0 credits, eligible, none yet)
     * @param {boolean} [p.freeConsultation]
     * @param {object} [p.assistant]             persona, for context only
     * @returns {{ cognisys, clinicianSummary, diagnostic, model } | null}
     */
    async function endAnalysis({ conversationId, trigger, includeDiagnostic = false, freeConsultation = false, assistant = null }) {
        const session = await store.loadSession(conversationId);
        if (!session || !session.needsAnalysis || !session.transcript.length) return null;
        const turnsAtStart = session.totalTurns;
        const snapshot = compactSnapshot(await cognisys.getSnapshot(session.profileId));
        const persona = assistant ? [assistant.name, assistant.domain, assistant.description].filter(Boolean).join(' · ') : 'platform default';
        const input = `Why this analysis is being written: ${trigger === 'credits_exhausted' ? 'the patient has used all their credits' : 'the conversation went idle'}.\n`
            + `Conversation escalated to the care team: ${session.escalation?.active ? `yes (${session.escalation.reason})` : 'no'}.\n`
            + `Assistant persona: ${persona}\n\n`
            + `--- Stored Cognisys profile (read-only) ---\n${JSON.stringify(snapshot)}\n\n`
            + `--- Automated screening signals per patient message ---\n${signalsText(sessionSignals(session))}\n\n`
            + `--- Conversation ---\n${transcriptText(session.transcript)}`;
        const { data, model } = await withRetry(pickModel(session), {
            system: analysisSystem(config, { includeDiagnostic, freeConsultation }),
            schema: analysisSchema({ includeDiagnostic }), input, session, kind: 'end_analysis',
        });

        const summary = forceUrgent(data.clinicianSummary, session);
        await store.saveSummary({ conversationId, profileId: session.profileId, trigger, model, urgent: summary.urgent, summary });
        await cognisys.apply(session.profileId, data.cognisys);
        await notify({ type: 'clinician_summary', conversationId, profileId: session.profileId, trigger, urgent: summary.urgent, summary });

        // Close the session unless the patient wrote again meanwhile. The next session starts fresh, with continuity.
        // Only this short step takes the conversation lock: the Claude call above can take a minute.
        await lock(conversationId, async () => {
            const latest = await store.loadSession(conversationId);
            if (!latest || latest.totalTurns !== turnsAtStart) return;
            const recent = transcriptText(latest.transcript).split('\n').slice(-config.contextMessages).join('\n');
            latest.previousContext = `Profile summary: ${data.cognisys?.profile?.summary || 'none'}\nLast messages:\n${recent}`;
            latest.transcript = [];
            latest.turns = 0;
            latest.costUsd = 0;                         // the ceiling applies per conversation
            latest.sessionNumber += 1;
            latest.needsAnalysis = false;
            latest.lastAnalysisAt = now().toISOString();
            await store.saveSession(latest);
        });
        // The pre-diagnostic is shown to the patient: same script clean-up as chat replies.
        const diagnostic = includeDiagnostic && data.diagnostic ? {
            ...data.diagnostic,
            summary: fixMixedScript(data.diagnostic.summary),
            recommendation: fixMixedScript(data.diagnostic.recommendation),
            concerns: (data.diagnostic.concerns || []).map((c) => ({ ...c, name: fixMixedScript(c.name), note: fixMixedScript(c.note) })),
        } : null;
        return { cognisys: data.cognisys, clinicianSummary: summary, diagnostic, model };
    }

    return { urgentSummary, endAnalysis, pickModel };
}
