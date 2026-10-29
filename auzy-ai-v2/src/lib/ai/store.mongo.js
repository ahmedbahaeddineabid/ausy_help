// MongoDB implementation of the store interface used by turn.service.js and analysis.service.js
// (tested against test/helpers.js#fakeStore, which has the same four methods).

import { AiSession } from '../../model/AiSession.js';
import { AiUsage } from '../../model/AiUsage.js';
import { ClinicianSummary } from '../../model/ClinicianSummary.js';

const iso = (d) => (d ? new Date(d).toISOString() : null);
const id = (v) => (v ? String(v) : null);

function toCore(doc) {
    if (!doc) return null;
    const e = doc.escalation || {};
    return {
        conversationId: id(doc.conversation),
        profileId: id(doc.profile),
        transcript: doc.transcript || [],
        escalation: { active: Boolean(e.active), since: iso(e.since), reason: e.reason || null, clearedAt: iso(e.clearedAt), clearedBy: id(e.clearedBy) },
        signals: doc.signals || [],
        turns: doc.turns || 0,
        totalTurns: doc.totalTurns || 0,
        sessionNumber: doc.sessionNumber || 1,
        needsAnalysis: Boolean(doc.needsAnalysis),
        previousContext: doc.previousContext || null,
        language: doc.language || null,
        lastTurnAt: iso(doc.lastTurnAt),
        lastAnalysisAt: iso(doc.lastAnalysisAt),
        costUsd: doc.costUsd || 0,
        totalCostUsd: doc.totalCostUsd || 0,
    };
}

export const mongoStore = {
    async loadSession(conversationId) {
        return toCore(await AiSession.findOne({ conversation: conversationId }).lean());
    },

    async saveSession(s) {
        await AiSession.updateOne(
            { conversation: s.conversationId },
            {
                $set: {
                    profile: s.profileId || undefined,
                    transcript: s.transcript,
                    escalation: s.escalation,
                    signals: s.signals,
                    turns: s.turns,
                    totalTurns: s.totalTurns,
                    sessionNumber: s.sessionNumber,
                    needsAnalysis: s.needsAnalysis,
                    previousContext: s.previousContext,
                    language: s.language,
                    lastTurnAt: s.lastTurnAt,
                    lastAnalysisAt: s.lastAnalysisAt,
                    costUsd: s.costUsd || 0,
                    totalCostUsd: s.totalCostUsd || 0,
                },
            },
            { upsert: true },
        );
    },

    async logUsage(r) {
        await AiUsage.create({
            conversation: r.conversationId, profile: r.profileId || undefined, session: r.session ?? undefined, kind: r.kind, model: r.model,
            input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, costUsd: r.costUsd, refused: r.refused,
        });
    },

    async saveSummary(r) {
        await ClinicianSummary.create({
            conversation: r.conversationId, profile: r.profileId || undefined, trigger: r.trigger, model: r.model,
            urgent: Boolean(r.urgent), summary: r.summary,
        });
    },
};
