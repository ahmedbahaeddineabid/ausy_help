// In-memory store (STORE=memory), with the same interface as store/mongo.js. For local runs and tests only:
// everything is lost when the process stops, and it is refused when NODE_ENV=production.

const DAY_MS = 86400000;

export function createMemoryStore({ now = () => new Date() } = {}) {
    const sessions = new Map();        // conversationId -> engine session
    const conversations = new Map();   // conversationId -> what auzy-backend sent with the latest message
    const usage = [];
    const summaries = [];
    const analyses = [];
    const settings = new Map();
    const copy = (v) => (v === undefined ? v : structuredClone(v));
    let seq = 0;
    const newId = () => (seq += 1).toString(16).padStart(24, '0');
    const newestFirst = (a, b) => b.createdAt - a.createdAt;

    return {
        kind: 'memory',
        async ping() { return true; },
        async close() {},

        // Engine interface (same as src/lib/ai/store.mongo.js)
        async loadSession(id) { return sessions.has(id) ? copy(sessions.get(id)) : null; },
        async saveSession(s) { sessions.set(s.conversationId, copy(s)); },
        async logUsage(r) { usage.push({ ...copy(r), createdAt: now() }); },
        async saveSummary(r) { summaries.push({ id: newId(), ...copy(r), createdAt: now() }); },

        async saveConversationInfo(id, info) { conversations.set(id, copy(info)); },
        async loadConversationInfo(id) { return copy(conversations.get(id)) || null; },

        /** Conversations with an unanalysed session whose last message is older than `before`, oldest first. */
        async dueForAnalysis(before, limit) {
            return [...sessions.values()]
                .filter((s) => s.needsAnalysis && s.lastTurnAt && new Date(s.lastTurnAt) <= before)
                .sort((a, b) => new Date(a.lastTurnAt) - new Date(b.lastTurnAt))
                .slice(0, limit)
                .map((s) => ({ conversationId: s.conversationId, lastTurnAt: s.lastTurnAt }));
        },

        async saveAnalysis(rec) {
            const id = newId();
            analyses.push({ id, ...copy(rec), createdAt: now() });
            return id;
        },
        async getAnalysis(id) { return copy(analyses.find((a) => a.id === id)) || null; },
        async updateAnalysis(id, set) {
            const a = analyses.find((x) => x.id === id);
            if (a) Object.assign(a, copy(set));
        },
        async analysesToDeliver(at, limit) {
            return analyses.filter((a) => a.delivery === 'pending' && new Date(a.nextAttemptAt) <= at).slice(0, limit).map((a) => a.id);
        },
        async listAnalyses(conversationId, limit = 20) {
            return copy(analyses.filter((a) => a.conversationId === conversationId).sort(newestFirst).slice(0, limit));
        },

        async listSummaries({ urgent = false, conversationId = null, limit = 50 } = {}) {
            return copy(summaries
                .filter((s) => (!urgent || s.urgent) && (!conversationId || s.conversationId === conversationId))
                .sort((a, b) => (b.urgent - a.urgent) || newestFirst(a, b))
                .slice(0, limit));
        },

        async usageTotals(since) {
            const rows = usage.filter((r) => r.createdAt >= since);
            const groups = new Map();
            for (const r of rows) {
                const key = `${r.kind}|${r.model}`;
                const g = groups.get(key) || { kind: r.kind, model: r.model, calls: 0, usd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
                g.calls += 1;
                g.usd += r.costUsd;
                for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) g[k] += r[k] || 0;
                groups.set(key, g);
            }
            return {
                totalUsd: rows.reduce((t, r) => t + r.costUsd, 0),
                conversations: new Set(rows.map((r) => r.conversationId)).size,
                byKindAndModel: [...groups.values()].sort((a, b) => b.usd - a.usd),
            };
        },

        /** Average cost of finished conversations (a session that got its end-of-conversation analysis), like budget.mongo.js. */
        async measureAverageCost(windowDays) {
            const since = new Date(now().getTime() - windowDays * DAY_MS);
            const groups = new Map();
            for (const r of usage) {
                if (r.createdAt < since || r.session == null) continue;
                const key = `${r.conversationId}|${r.session}`;
                const g = groups.get(key) || { usd: 0, ended: false };
                g.usd += r.costUsd;
                g.ended = g.ended || r.kind === 'end_analysis';
                groups.set(key, g);
            }
            const finished = [...groups.values()].filter((g) => g.ended).map((g) => g.usd);
            if (!finished.length) return { since, avgUsd: null, maxUsd: null, samples: 0 };
            return { since, avgUsd: finished.reduce((a, b) => a + b, 0) / finished.length, maxUsd: Math.max(...finished), samples: finished.length };
        },

        async getSetting(key) { return copy(settings.get(key)) ?? null; },
        async setSetting(key, value) { settings.set(key, copy(value)); },
    };
}
