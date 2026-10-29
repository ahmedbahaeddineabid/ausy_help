import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnalysisService, transcriptText, compactSnapshot } from '../src/lib/ai/analysis.service.js';
import { newSession } from '../src/lib/ai/turn.service.js';
import { config, HAIKU, SONNET, fakeClient, fakeStore, recorder, json, cutOff, silentLog } from './helpers.js';

const summary = (over = {}) => ({
    urgent: false, urgency_reason: 'not discussed', risk_flags: [], main_concerns: 'stress au travail',
    symptoms: [{ symptom: 'sommeil réduit', duration: 'quelques semaines', frequency_severity: '4-5 h par nuit' }],
    triggers_stressors: 'travail', sleep: '4-5 h', appetite: 'not discussed', functioning: 'not discussed', history: 'not discussed',
    risk_factors: 'not discussed', protective_factors: 'not discussed', suggested_screening: ['PHQ-9'], consultation: 'agreed',
    patient_language: 'en', narrative: 'Stress au travail.', ...over,
});
const cognisys = { facts: [{ category: 'Sleep', key: 'sleep-hours', value: 4, valueType: 'number', unit: 'hours', confidence: 85, source: 'confessed' }],
    dimensions: [{ dimension: 'Sleep', score: 30, factors: ['4-5 h per night'] }], analysisAppend: { analysisType: 'periodic', summary: 'Sleep worsened.' },
    profile: { summary: 'Work stress and poor sleep.', tags: ['stress'], keyInsights: [], riskFactors: [], opportunities: ['open to consultation'] } };
const diagnostic = { summary: 'Signs of stress.', concerns: [{ name: 'Stress', severity: 'moderate', note: 'Work overload.' }], recommendation: 'Book the free consultation.' };

const transcript = (patient = 'I barely sleep, work is too much', extra = []) => [
    { role: 'user', content: [{ type: 'text', text: patient }] },
    { role: 'system', content: 'Screening signals for the latest message: likely state: stress; no risk signal.' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 't', name: 'find_tests', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: '{"tests":[]}' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'That sounds exhausting.\n<risk>none</risk>' }] },
    ...extra,
];

async function make({ script = [], session = {} } = {}) {
    const client = fakeClient(script);
    const store = fakeStore();
    const applied = [];
    const fakeCognisys = { getSnapshot: async () => ({ profile: { summary: 'old', tags: [] }, facts: [], dimensions: [], analyses: [] }), apply: async (pid, out) => { applied.push([pid, out]); } };
    const notify = recorder();
    await store.saveSession({ ...newSession('c1', 'prof1'), transcript: transcript(), turns: 5, totalTurns: 5, needsAnalysis: true, language: 'en', ...session });
    const svc = createAnalysisService({ client, config, store, cognisys: fakeCognisys, notify, log: silentLog });
    return { client, store, svc, applied, notify };
}

test('transcript text: patient and assistant words only, no thinking, tools, hints or tags', () => {
    const t = transcriptText(transcript());
    assert.equal(t, 'PATIENT: I barely sleep, work is too much\nASSISTANT: That sounds exhausting.');
});

test('model choice: Haiku for English/French, Sonnet for Arabic, Derja and escalated conversations', async () => {
    const { svc } = await make();
    const s = (patient, over = {}) => ({ ...newSession('x', 'p'), transcript: transcript(patient), ...over });
    assert.equal(svc.pickModel(s('I barely sleep')), HAIKU);
    assert.equal(svc.pickModel(s('Je dors mal ces derniers temps')), HAIKU);
    assert.equal(svc.pickModel(s('ما نرقدش مليح')), SONNET);
    assert.equal(svc.pickModel(s('ma nor9odch mli7 w dima 5ayfa')), SONNET);
    assert.equal(svc.pickModel(s('I barely sleep', { escalation: { active: true, reason: 'x' } })), SONNET);
});

test('end analysis: one call -> Cognisys update, clinician summary, pre-diagnostic; session closed with continuity', async () => {
    const { client, store, svc, applied, notify } = await make({ script: [json({ cognisys, clinicianSummary: summary(), diagnostic })] });
    const out = await svc.endAnalysis({ conversationId: 'c1', trigger: 'credits_exhausted', includeDiagnostic: true, freeConsultation: true });
    const req = client.analysisRequests()[0];
    assert.equal(req.model, HAIKU);
    assert.deepEqual(Object.keys(req.output_config.format.schema.properties), ['cognisys', 'clinicianSummary', 'diagnostic']);
    assert.match(req.system[0].text, /free 15-minute consultation/);
    assert.match(req.messages[0].content, /used all their credits/);
    assert.ok(!req.messages[0].content.includes('signature') && !req.messages[0].content.includes('tool_result'));
    assert.deepEqual(out.diagnostic, diagnostic);
    assert.deepEqual(applied, [['prof1', cognisys]]);
    assert.equal(store.summaries[0].trigger, 'credits_exhausted');
    assert.equal(notify.calls[0].type, 'clinician_summary');
    const s = await store.loadSession('c1');
    assert.equal(s.transcript.length, 0);
    assert.equal(s.turns, 0);
    assert.equal(s.sessionNumber, 2);
    assert.equal(s.needsAnalysis, false);
    assert.match(s.previousContext, /Work stress and poor sleep.*PATIENT: I barely sleep/s);
    assert.equal(store.usageRows[0].kind, 'end_analysis');
});

test('end analysis without diagnostic: the schema leaves it out', async () => {
    const { client, svc } = await make({ script: [json({ cognisys, clinicianSummary: summary() })] });
    const out = await svc.endAnalysis({ conversationId: 'c1', trigger: 'idle' });
    assert.deepEqual(Object.keys(client.analysisRequests()[0].output_config.format.schema.properties), ['cognisys', 'clinicianSummary']);
    assert.equal(out.diagnostic, null);
});

test('a cut-off answer is retried once on Sonnet', async () => {
    const { client, store, svc } = await make({ script: [cutOff(), json({ cognisys, clinicianSummary: summary() })] });
    const out = await svc.endAnalysis({ conversationId: 'c1', trigger: 'idle' });
    assert.deepEqual(client.analysisRequests().map((r) => r.model), [HAIKU, SONNET]);
    assert.equal(out.model, SONNET);
    assert.equal(store.usageRows.length, 2);                              // the failed attempt's cost is logged too
});

test('escalated conversation: Sonnet, and the summary is always urgent', async () => {
    const { client, store, svc } = await make({
        script: [json({ cognisys, clinicianSummary: summary({ urgent: false }) })],
        session: { escalation: { active: true, since: 'x', reason: 'crisis phrase (suicidal, en)' } },
    });
    const out = await svc.endAnalysis({ conversationId: 'c1', trigger: 'idle' });
    assert.equal(client.analysisRequests()[0].model, SONNET);
    assert.equal(out.clinicianSummary.urgent, true);
    assert.match(store.summaries[0].summary.urgency_reason, /escalated by automated checks/);
});

test('urgent summary: Sonnet, summary schema only, saved as an escalation summary', async () => {
    const { client, store, svc } = await make({ script: [json(summary({ urgent: true, risk_flags: ['suicidal'] }))],
        session: { escalation: { active: true, since: 'x', reason: 'crisis phrase (suicidal, en)' } } });
    await svc.urgentSummary('c1');
    const req = client.analysisRequests()[0];
    assert.equal(req.model, SONNET);
    assert.ok(req.output_config.format.schema.properties.narrative);
    assert.equal(store.summaries[0].trigger, 'escalation');
    assert.equal(store.summaries[0].urgent, true);
});

test('the session is not closed if the patient wrote again during the analysis', async () => {
    const { store, svc } = await make({ script: [json({ cognisys, clinicianSummary: summary() })] });
    const slowCognisys = { getSnapshot: async () => null, apply: async () => {
        const s = await store.loadSession('c1');
        await store.saveSession({ ...s, totalTurns: s.totalTurns + 1 });       // a new turn lands meanwhile
    } };
    const svc2 = createAnalysisService({ client: fakeClient([json({ cognisys, clinicianSummary: summary() })]), config, store, cognisys: slowCognisys, log: silentLog });
    await svc2.endAnalysis({ conversationId: 'c1', trigger: 'idle' });
    const s = await store.loadSession('c1');
    assert.ok(s.transcript.length > 0);
    assert.equal(s.needsAnalysis, true);
    assert.ok(svc);
});

test('only the current session\'s signals reach the analysis; closing the session goes through the lock', async () => {
    const locked = [];
    const client = fakeClient([json({ cognisys, clinicianSummary: summary() })]);
    const store = fakeStore();
    await store.saveSession({ ...newSession('c1', 'p'), transcript: transcript(), turns: 1, totalTurns: 6, needsAnalysis: true,
        signals: [{ turn: 2, state: 'suicidal', reasons: ['OLD SESSION SIGNAL'] }, { turn: 6, state: 'stress', reasons: [] }] });
    const svc = createAnalysisService({ client, config, store, cognisys: { getSnapshot: async () => null, apply: async () => {} },
        lock: async (id, fn) => { locked.push(id); return fn(); }, log: silentLog });
    await svc.endAnalysis({ conversationId: 'c1', trigger: 'idle' });
    const input = client.analysisRequests()[0].messages[0].content;
    assert.ok(!input.includes('OLD SESSION SIGNAL'));
    assert.match(input, /message 6: likely state stress/);
    assert.deepEqual(locked, ['c1']);
});

test('nothing to analyse: no call', async () => {
    const { client, svc } = await make({ session: { needsAnalysis: false } });
    assert.equal(await svc.endAnalysis({ conversationId: 'c1', trigger: 'idle' }), null);
    assert.equal(client.requests.length, 0);
});

test('snapshot sent to Claude is compact', () => {
    const snap = compactSnapshot({ profile: { summary: 's', tags: ['a'], _id: 'x', createdAt: 'y' }, facts: [{ category: 'c', key: 'k', value: 1, _id: 'f', confidence: 90 }],
        dimensions: [{ dimension: 'mood', score: 40, factors: ['x'], _id: 'd' }], analyses: [1, 2, 3, 4].map((i) => ({ analysisType: 'periodic', summary: `s${i}`, _id: i })) });
    assert.deepEqual(snap.facts, [{ category: 'c', key: 'k', value: 1 }]);
    assert.deepEqual(snap.dimensions, [{ dimension: 'mood', score: 40 }]);
    assert.equal(snap.recentAnalyses.length, 3);
    assert.equal(snap.profile._id, undefined);
});
