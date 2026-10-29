// Checks server/store/mongo.js against a real MongoDB (free). Creates a throwaway database
// (auzy_ai_check_<random>) and drops it at the end; nothing else is touched.
//   MONGODB_URI=mongodb://... node test/mongo.store.check.mjs

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { createMongoStore } from '../server/store/mongo.js';
import { newSession } from '../src/lib/ai/turn.service.js';
import { HAIKU, SONNET } from '../src/config/ai.config.js';

const uri = process.env.MONGODB_URI;
if (!uri) {
    console.error('Set MONGODB_URI to a MongoDB where a throwaway database can be created.');
    process.exit(1);
}
const dbName = `auzy_ai_check_${randomBytes(4).toString('hex')}`;
const C1 = '6650000000000000000000c1';
const C2 = '6650000000000000000000c2';
const P = '6650000000000000000000d1';
const T0 = '2026-11-02T10:00:00.000Z';

const store = await createMongoStore({ uri, dbName });
let failed = 0;
async function step(name, fn) {
    try {
        await fn();
        console.log(`PASS ${name}`);
    } catch (e) {
        failed += 1;
        console.log(`FAIL ${name}\n${e.stack}`);
    }
}
const usage = (over) => ({ kind: 'chat', model: HAIKU, input: 100, output: 50, cacheRead: 2000, cacheWrite: 0, costUsd: 0.001, refused: false,
    conversationId: C1, profileId: P, session: 1, ...over });

try {
    await step('ping', async () => assert.equal(await store.ping(), true));

    await step('session round trip in the engine format (ids and dates as strings)', async () => {
        const s = {
            ...newSession(C1, P), turns: 2, totalTurns: 2, needsAnalysis: true, language: 'aeb', lastTurnAt: T0, costUsd: 0.02, totalCostUsd: 0.03,
            transcript: [{ role: 'user', content: [{ type: 'text', text: 'Aslema' }] }, { role: 'system', content: 'hint' },
                { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'Aslema!' }] }],
            signals: [{ turn: 1, at: T0, state: 'stress', riskScore: 0.02, model: SONNET, reasons: [], riskFlag: null }],
            escalation: { active: true, since: T0, reason: 'crisis phrase (abuse, aeb)', clearedAt: null, clearedBy: null },
            previousContext: 'Profile summary: none',
        };
        await store.saveSession(s);
        assert.deepEqual(await store.loadSession(C1), { ...s, lastAnalysisAt: null });
        await store.saveSession({ ...s, escalation: { ...s.escalation, active: false, clearedAt: T0, clearedBy: P } });
        assert.deepEqual((await store.loadSession(C1)).escalation, { active: false, since: T0, reason: 'crisis phrase (abuse, aeb)', clearedAt: T0, clearedBy: P });
        assert.equal(await store.loadSession(C2), null);
    });

    await step('idle poll: unanalysed sessions older than the cut-off, oldest first', async () => {
        await store.saveSession({ ...newSession(C2, P), needsAnalysis: true, lastTurnAt: '2026-11-02T09:00:00.000Z' });
        assert.deepEqual(await store.dueForAnalysis(new Date('2026-11-02T10:30:00Z'), 10),
            [{ conversationId: C2, lastTurnAt: '2026-11-02T09:00:00.000Z' }, { conversationId: C1, lastTurnAt: T0 }]);
        assert.deepEqual(await store.dueForAnalysis(new Date('2026-11-02T09:30:00Z'), 10), [{ conversationId: C2, lastTurnAt: '2026-11-02T09:00:00.000Z' }]);
        await store.saveSession({ ...(await store.loadSession(C2)), needsAnalysis: false });
        assert.equal((await store.dueForAnalysis(new Date('2026-11-03T00:00:00Z'), 10)).length, 1);
    });

    await step('conversation info (credits, eligibility, persona) is kept and updated', async () => {
        await store.saveConversationInfo(C1, { profileId: P, creditsRemaining: 3, freeConsultationEligible: true, persona: { name: 'Sami', domain: 'stress' } });
        await store.saveConversationInfo(C1, { profileId: P, creditsRemaining: 0, freeConsultationEligible: true, persona: { name: 'Sami', domain: 'stress' } });
        assert.deepEqual(await store.loadConversationInfo(C1), { profileId: P, creditsRemaining: 0, freeConsultationEligible: true, persona: { name: 'Sami', domain: 'stress' } });
        assert.equal(await store.loadConversationInfo(C2), null);
    });

    await step('clinician summaries: urgent first, filters', async () => {
        await store.saveSummary({ conversationId: C1, profileId: P, trigger: 'idle', model: HAIKU, urgent: false, summary: { narrative: 'routine' } });
        await store.saveSummary({ conversationId: C2, profileId: P, trigger: 'escalation', model: SONNET, urgent: true, summary: { narrative: 'urgent' } });
        const all = await store.listSummaries({});
        assert.deepEqual(all.map((s) => s.summary.narrative), ['urgent', 'routine']);
        assert.match(all[0].id, /^[a-f\d]{24}$/);
        assert.equal(all[0].conversationId, C2);
        assert.ok(all[0].createdAt instanceof Date);
        assert.deepEqual((await store.listSummaries({ urgent: true })).map((s) => s.trigger), ['escalation']);
        assert.deepEqual((await store.listSummaries({ conversationId: C1 })).map((s) => s.trigger), ['idle']);
    });

    await step('usage ledger: totals by kind and model, average cost of finished conversations', async () => {
        await store.logUsage(usage({}));
        await store.logUsage(usage({ kind: 'second_opinion', model: SONNET, costUsd: 0.006 }));
        await store.logUsage(usage({ kind: 'end_analysis', model: SONNET, costUsd: 0.02 }));
        await store.logUsage(usage({ conversationId: C2, costUsd: 0.003 }));                    // C2: not finished
        const t = await store.usageTotals(new Date(Date.now() - 86400000));
        assert.equal(t.conversations, 2);
        assert.ok(Math.abs(t.totalUsd - 0.030) < 1e-9);
        assert.deepEqual(t.byKindAndModel.map((r) => [r.kind, r.model, r.calls]),
            [['end_analysis', SONNET, 1], ['second_opinion', SONNET, 1], ['chat', HAIKU, 2]]);
        assert.equal(t.byKindAndModel[2].cacheRead, 4000);
        const m = await store.measureAverageCost(7);
        assert.equal(m.samples, 1);
        assert.ok(Math.abs(m.avgUsd - 0.027) < 1e-9);
        assert.ok(Math.abs(m.maxUsd - 0.027) < 1e-9);
    });

    await step('analyses: kept, delivered, retried, listed', async () => {
        const id = await store.saveAnalysis({ conversationId: C1, profileId: P, trigger: 'credits_exhausted', model: SONNET,
            result: { cognisys: { facts: [] }, clinicianSummary: { urgent: false }, diagnostic: null }, delivery: 'pending', attempts: 0, nextAttemptAt: new Date() });
        assert.match(id, /^[a-f\d]{24}$/);
        assert.deepEqual(await store.analysesToDeliver(new Date(), 10), [id]);
        await store.updateAnalysis(id, { attempts: 1, lastError: 'HTTP 500', nextAttemptAt: new Date(Date.now() + 120000) });
        assert.deepEqual(await store.analysesToDeliver(new Date(), 10), []);
        assert.deepEqual(await store.analysesToDeliver(new Date(Date.now() + 180000), 10), [id]);
        await store.updateAnalysis(id, { delivery: 'delivered', attempts: 2, deliveredAt: new Date(), lastError: null });
        const a = await store.getAnalysis(id);
        assert.deepEqual([a.delivery, a.attempts, a.lastError, a.conversationId, a.trigger], ['delivered', 2, null, C1, 'credits_exhausted']);
        assert.deepEqual(a.result, { cognisys: { facts: [] }, clinicianSummary: { urgent: false }, diagnostic: null });
        assert.equal((await store.listAnalyses(C1)).length, 1);
        assert.equal(await store.getAnalysis('not-an-id'), null);
        assert.equal(await store.getAnalysis('6650000000000000000000ff'), null);
    });

    await step('settings (budget level) are kept', async () => {
        assert.equal(await store.getSetting('budget'), null);
        await store.setSetting('budget', { level: 0, decidedAt: T0, changedAt: T0 });
        await store.setSetting('budget', { level: 1, decidedAt: T0, changedAt: null });
        assert.deepEqual(await store.getSetting('budget'), { level: 1, decidedAt: T0, changedAt: null });
    });

    await step('indexes exist (one session per conversation, idle poll, delivery queue)', async () => {
        const names = async (c) => (await mongoose.connection.db.collection(c).indexes()).map((i) => i.name);
        assert.ok((await names('aisessions')).includes('conversation_1'));
        assert.ok((await names('aisessions')).includes('needsAnalysis_1_lastTurnAt_1'));
        assert.ok((await names('aianalyses')).includes('delivery_1_nextAttemptAt_1'));
        assert.ok((await names('aiapiconversations')).includes('conversation_1'));
        await assert.rejects(mongoose.connection.db.collection('aisessions').insertOne({ conversation: new mongoose.Types.ObjectId(C1) }), /duplicate key/);
    });
} finally {
    if (mongoose.connection.db?.databaseName === dbName && dbName.startsWith('auzy_ai_check_')) await mongoose.connection.db.dropDatabase();
    await store.close();
}
console.log(failed ? `\n${failed} check(s) failed` : `\nAll MongoDB store checks passed (database ${dbName} created and dropped).`);
process.exit(failed ? 1 : 0);
