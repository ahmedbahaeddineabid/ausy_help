import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextLevel, usesCarefulForRoutine, createBudgetLevel } from '../src/lib/ai/budget.js';
import { createTurnService, newSession } from '../src/lib/ai/turn.service.js';
import { createAnalysisService } from '../src/lib/ai/analysis.service.js';
import { config, HAIKU, SONNET, fakeClient, fakeStore, fakeRisk, recorder, reply, json, silentLog } from './helpers.js';

const budget = config.budget;
const derja = 'ta3bana barcha el ayem hedhi';
const english = 'Work has been stressful lately';

function make({ level = 1, script = [], session = null } = {}) {
    const client = fakeClient(script);
    const store = fakeStore();
    const escalate = recorder();
    const policy = createBudgetLevel({ ...budget, startLevel: level });
    const turns = createTurnService({ client, config, risk: fakeRisk(), store, escalate, policy, log: silentLog });
    const turn = async (userText, extra = {}) => {
        if (session && !(await store.loadSession('c1'))) await store.saveSession({ ...newSession('c1', 'p1'), ...session });
        return turns.handleTurn({ conversationId: 'c1', profileId: 'p1', assistant: null, toolbox: null, userText, ...extra });
    };
    const first = () => client.chatRequests()[0];
    return { client, store, escalate, turn, first, policy };
}

test('governor: no change without enough finished conversations', () => {
    assert.equal(nextLevel({ current: 1, avgUsd: 0.2, samples: budget.minSamples - 1, daysSinceChange: 99, budget }), 1);
    assert.equal(nextLevel({ current: 1, avgUsd: null, samples: 500, daysSinceChange: 99, budget }), 1);
});

test('governor: over $80 per 1,000 steps down at once, never below economy', () => {
    assert.equal(nextLevel({ current: 1, avgUsd: 0.095, samples: 200, daysSinceChange: 0, budget }), 0);
    assert.equal(nextLevel({ current: 0, avgUsd: 0.095, samples: 200, daysSinceChange: 0, budget }), 0);
});

test('governor: under $50 per 1,000 steps up only after the cooldown, never above premium', () => {
    assert.equal(nextLevel({ current: 1, avgUsd: 0.03, samples: 200, daysSinceChange: 1, budget }), 1);
    assert.equal(nextLevel({ current: 1, avgUsd: 0.03, samples: 200, daysSinceChange: 3, budget }), 2);
    assert.equal(nextLevel({ current: 2, avgUsd: 0.03, samples: 200, daysSinceChange: 30, budget }), 2);
});

test('governor: inside the $50-80 band nothing changes', () => {
    assert.equal(nextLevel({ current: 1, avgUsd: 0.065, samples: 200, daysSinceChange: 30, budget }), 1);
});

test('levels: who writes routine replies', () => {
    assert.equal(usesCarefulForRoutine(0, 'aeb', budget), false);
    assert.equal(usesCarefulForRoutine(1, 'aeb', budget), true);
    assert.equal(usesCarefulForRoutine(1, 'ar', budget), true);
    assert.equal(usesCarefulForRoutine(1, 'fr', budget), false);
    assert.equal(usesCarefulForRoutine(2, 'en', budget), true);
    const l = createBudgetLevel({ ...budget, startLevel: 9 });
    assert.equal(l.level(), 2);
    l.set(-3);
    assert.equal(l.name(), 'economy');
});

test('standard level: Derja routine replies on Sonnet at low effort, English on Haiku', async () => {
    const d = make({ level: 1 });
    const r = await d.turn(derja);
    assert.equal(d.first().model, SONNET);
    assert.equal(d.first().output_config.effort, 'low');
    assert.equal(r.escalated, false);
    const e = make({ level: 1 });
    await e.turn(english);
    assert.equal(e.first().model, HAIKU);
    assert.equal(e.first().output_config.effort, 'low');
});

test('economy level: Derja on Haiku; premium level: English on Sonnet at low effort', async () => {
    const eco = make({ level: 0 });
    await eco.turn(derja);
    assert.equal(eco.first().model, HAIKU);
    const pre = make({ level: 2 });
    await pre.turn(english);
    assert.equal(pre.first().model, SONNET);
    assert.equal(pre.first().output_config.effort, 'low');
});

test('second opinion keeps the effort of a quality conversation (cache stays valid); medium otherwise', async () => {
    const q = make({ level: 1 });
    await q.turn(`MODELRISK ${derja}`);
    assert.equal(q.first().model, SONNET);
    assert.equal(q.first().output_config.effort, 'low');
    const h = make({ level: 1 });
    await h.turn(`MODELRISK ${english}`);
    assert.equal(h.first().model, SONNET);
    assert.equal(h.first().output_config.effort, 'medium');
});

test('in a quality conversation the careful model\'s own risk tag escalates directly', async () => {
    const q = make({ level: 1, script: [reply('Ena m3ak.', 'abuse')] });
    const r = await q.turn(derja);
    assert.equal(r.escalated, true);
    assert.equal(q.client.chatRequests().length, 1);              // no extra second-opinion call needed
});

test('crisis: Sonnet at medium effort, whatever the level', async () => {
    for (const level of [0, 1, 2]) {
        const m = make({ level });
        await m.turn('PHRASE I want to kill myself');
        assert.equal(m.first().model, SONNET);
        assert.equal(m.first().output_config.effort, 'medium');
    }
});

test('over the 15c ceiling: routine replies drop to Haiku, but a crisis keeps Sonnet', async () => {
    const over = make({ level: 1, session: { costUsd: budget.conversationCeilingUsd + 0.01 } });
    await over.turn(derja);
    assert.equal(over.first().model, HAIKU);
    const crisis = make({ level: 1, session: { costUsd: 0.5, escalation: { active: true, since: 'x', reason: 'r' } } });
    await crisis.turn(derja);
    assert.equal(crisis.first().model, SONNET);
    assert.equal(crisis.first().output_config.effort, 'medium');
    const soft = make({ level: 1, session: { costUsd: 0.5 } });
    await soft.turn(`MODELRISK ${derja}`);
    assert.equal(soft.first().model, SONNET);                     // second opinions are safety: never cut
});

test('cost is tracked per turn and per conversation, and every ledger row carries the session number', async () => {
    const m = make({ level: 1 });
    const r1 = await m.turn(english);
    const r2 = await m.turn('ok');
    const rows = m.store.usageRows;
    const sum = rows.reduce((a, u) => a + u.costUsd, 0);
    assert.ok(Math.abs(r2.conversationCostUsd - sum) < 1e-12);
    assert.ok(Math.abs(r1.costUsd + r2.costUsd - sum) < 1e-12);
    assert.ok(rows.every((u) => u.session === 1));
    assert.ok(Math.abs((await m.store.loadSession('c1')).costUsd - sum) < 1e-12);
});

test('analysis: over the ceiling a Derja conversation is summarised by Haiku; an escalated one always by Sonnet', async () => {
    const out = { cognisys: { facts: [], dimensions: [], analysisAppend: { analysisType: 'periodic', summary: 's' }, profile: { summary: 's', tags: [], keyInsights: [], riskFactors: [], opportunities: [] } },
        clinicianSummary: { urgent: false, urgency_reason: '', risk_flags: [], main_concerns: '', symptoms: [], triggers_stressors: '', sleep: '', appetite: '', functioning: '', history: '', risk_factors: '', protective_factors: '', suggested_screening: [], consultation: 'not_discussed', patient_language: 'aeb', narrative: 'n' } };
    for (const [escalated, expected] of [[false, HAIKU], [true, SONNET]]) {
        const client = fakeClient([json(out)]);
        const store = fakeStore();
        await store.saveSession({ ...newSession('c1', 'p1'), language: 'aeb', costUsd: 0.2, needsAnalysis: true, turns: 1, totalTurns: 1,
            transcript: [{ role: 'user', content: [{ type: 'text', text: derja }] }, { role: 'assistant', content: [{ type: 'text', text: 'Ena m3ak.' }] }],
            escalation: { active: escalated, since: null, reason: escalated ? 'x' : null } });
        const svc = createAnalysisService({ client, config, store, cognisys: { getSnapshot: async () => null, apply: async () => {} }, log: silentLog });
        await svc.endAnalysis({ conversationId: 'c1', trigger: 'idle' });
        assert.equal(client.analysisRequests()[0].model, expected);
        assert.equal((await store.loadSession('c1')).costUsd, 0);  // a new conversation starts with a fresh ceiling
    }
});
