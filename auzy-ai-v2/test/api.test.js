import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSettings, checkSettings } from '../server/settings.js';
import { loadConfig } from '../src/config/ai.config.js';
import { createMemoryStore } from '../server/store/memory.js';
import { toSummary, toAnalysis, toConversationInfo } from '../server/store/mongo.js';
import { HAIKU, SONNET, reply, toolCall, lastHint, userTexts } from './helpers.js';
import { startApi, startAuzy, apiClient, API_KEY, STAFF_TOKEN, CONV, CONV2, PROFILE, sampleDiagnostic } from './api.helpers.js';

const MINUTE = 60000;

async function withApi(opts, fn) {
    const auzy = opts.mode === 'demo' ? null : await startAuzy();
    const api = await startApi({ ...opts, auzy });
    try {
        await fn(api, auzy);
    } finally {
        await api.close();
        await auzy?.close();
    }
}

test('auth: service key for messages, staff token for staff views, health is open', () => withApi({}, async (api) => {
    const body = { conversationId: CONV, profileId: PROFILE, text: 'hello' };
    assert.equal((await api.call('POST', '/v1/messages', { body, token: null })).status, 401);
    assert.equal((await api.call('POST', '/v1/messages', { body, token: 'wrong' })).status, 401);
    assert.equal((await api.call('POST', '/v1/messages', { body, token: STAFF_TOKEN })).status, 401);
    assert.equal((await api.call('GET', '/v1/summaries', { token: API_KEY })).status, 401);
    assert.equal((await api.call('GET', '/v1/summaries', { token: STAFF_TOKEN })).status, 200);
    const health = await api.call('GET', '/v1/health', { token: null });
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { ok: true, version: 'test', store: { kind: 'memory', ok: true }, riskService: { ok: true }, auzy: 'callback', budgetLevel: 'standard' });
    assert.equal((await api.call('GET', '/v1/nothing', { token: null })).status, 404);
}));

test('staff endpoints are refused when no staff token is configured', () => withApi({ env: { AUZY_AI_STAFF_TOKEN: '' } }, async (api) => {
    const r = await api.call('GET', '/v1/costs', { token: STAFF_TOKEN });
    assert.equal(r.status, 403);
    assert.match(r.body.message, /Staff access is not configured/);
}));

test('validation: ids, text, credits, persona, history, JSON', () => withApi({}, async (api) => {
    const bad = async (body, pattern) => {
        const r = await api.send(body);
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.match(r.body.message, pattern);
    };
    await bad({ conversationId: 'convA' }, /conversationId must be a 24-character/);
    await bad({ profileId: 42, text: 'x' }, /profileId must be/);
    await bad({ text: '   ' }, /text must be a non-empty string/);
    await bad({ text: 'x'.repeat(8001) }, /longer than 8000/);
    await bad({ text: 'x', creditsRemaining: -1 }, /creditsRemaining/);
    await bad({ text: 'x', creditsRemaining: '3' }, /creditsRemaining/);
    await bad({ text: 'x', freeConsultationEligible: 'yes' }, /freeConsultationEligible/);
    await bad({ text: 'x', persona: 'Auzy' }, /persona must be an object/);
    await bad({ text: 'x', persona: { name: 7 } }, /persona.name must be a string/);
    await bad({ text: 'x', notes: 'fr' }, /notes must be an array/);
    await bad({ text: 'x', history: {} }, /history must be an array/);
    const invalid = await api.call('POST', '/v1/messages', { raw: '{"text": ' });
    assert.deepEqual([invalid.status, invalid.body.error], [400, 'invalid_json']);
    assert.equal(api.client.requests.length, 0);
}));

test('routine turn: tools go through auzy-backend callbacks, cards come back, persona reaches the prompt', () => withApi({
    client: apiClient({ chat: [toolCall('find_tests', { search: 'sleep' }), toolCall('get_my_appointments', { when: 'upcoming' }, 'tu_2'), reply('You could try the PHQ-9.')] }),
}, async (api, auzy) => {
    const persona = { name: 'Sami', description: 'Soutien', behavior: 'chaleureux', rules: ['Short replies'], createdBy: 'ignored', price: 10 };
    const r = await api.send({ text: 'I barely sleep', persona, creditsRemaining: 5, notes: ['Chat language: English'] });
    assert.equal(r.status, 200);
    assert.equal(r.body.reply, 'You could try the PHQ-9.');
    assert.deepEqual(r.body.cards, { profiles: [], appointments: ['6650000000000000000000e1'], tests: ['6650000000000000000000b1'] });
    assert.equal(r.body.escalated, false);
    assert.equal(r.body.emergencyText, null);
    assert.equal(r.body.model, HAIKU);
    assert.deepEqual(r.body.followUp, []);
    assert.equal(r.body.error, null);
    assert.ok(r.body.costUsd > 0);
    assert.deepEqual(auzy.calls[0], ['tests', { search: 'sleep', limit: 3 }]);
    assert.deepEqual(auzy.calls[1], ['appointments', { profileId: PROFILE, when: 'upcoming', limit: 10 }]);     // this patient only, no role
    const first = api.client.chatRequests()[0];
    assert.match(first.system[1].text, /You speak as: Sami/);
    assert.match(first.system[1].text, /- Short replies/);
    assert.doesNotMatch(JSON.stringify(first.system), /ignored/);
    assert.match(lastHint(first).content, /changed a chat setting: Chat language: English/);
}));

test('crisis phrase: escalated reply, alert, urgent summary; staff view; clearing it brings back the routine model', () => withApi({
    client: apiClient({ chat: [reply('I am here with you. Please call 190 now.', 'suicidal'), reply('Glad you are safer.')] }),
}, async (api, auzy) => {
    const r = await api.send({ text: 'PHRASE I want to kill myself', creditsRemaining: 4 });
    assert.equal(r.body.escalated, true);
    assert.equal(r.body.model, SONNET);
    assert.match(r.body.emergencyText, /190/);
    assert.deepEqual(r.body.followUp, ['urgent_summary']);
    await api.scheduler.settled();
    assert.equal(auzy.hooks.find((h) => h.kind === 'escalation').body.conversationId, CONV);
    assert.equal(auzy.hooks.find((h) => h.kind === 'summary').body.urgent, true);

    const urgent = await api.staff('GET', '/v1/summaries?urgent=true');
    assert.equal(urgent.body.items.length, 1);
    assert.equal(urgent.body.items[0].trigger, 'escalation');
    const view = await api.staff('GET', `/v1/conversations/${CONV}`);
    assert.equal(view.body.escalation.active, true);
    assert.match(view.body.escalation.reason, /crisis phrase/);
    assert.equal(view.body.signals.length, 1);
    assert.equal(view.body.summaries.length, 1);
    assert.equal(view.body.transcript, undefined);

    assert.equal((await api.staff('POST', `/v1/conversations/${CONV}/clear-escalation`, { clearedBy: 'nobody' })).status, 400);
    const cleared = await api.staff('POST', `/v1/conversations/${CONV}/clear-escalation`, { clearedBy: PROFILE.toUpperCase() });
    assert.deepEqual(cleared.body, { cleared: true });
    const after = await api.send({ text: 'I feel a bit better today' });
    assert.equal(after.body.escalated, false);
    assert.equal(after.body.model, HAIKU);
    assert.equal((await api.staff('GET', `/v1/conversations/${CONV}`)).body.escalation.clearedBy, PROFILE);
}));

test('0 credits: closing reply, then analysis with Cognisys snapshot, delivered to auzy-backend once; session closed', () => withApi({
    client: apiClient({ chat: [reply('Take care, a pre-assessment will appear in your account.')] }),
}, async (api, auzy) => {
    const r = await api.send({ text: 'Thanks, that helped', creditsRemaining: 0, freeConsultationEligible: true, persona: { name: 'Sami', domain: 'stress' } });
    assert.deepEqual(r.body.followUp, ['end_analysis']);
    assert.match(lastHint(api.client.chatRequests()[0]).content, /free 15-minute consultation/);
    await api.scheduler.settled();

    assert.deepEqual(auzy.calls.find((c) => c[0] === 'cognisys'), ['cognisys', PROFILE]);
    const analysisReq = api.client.analysisRequests()[0];
    assert.match(analysisReq.messages[0].content, /Stored summary/);                 // the stored profile reached the prompt
    assert.match(analysisReq.messages[0].content, /Assistant persona: Sami · stress/);
    assert.equal(auzy.deliveries.length, 1);
    const d = auzy.deliveries[0];
    assert.equal(d.conversationId, CONV);
    assert.equal(d.profileId, PROFILE);
    assert.equal(d.trigger, 'credits_exhausted');
    assert.deepEqual(d.diagnostic, sampleDiagnostic);
    assert.equal(d.cognisys.profile.summary, 'Work stress and poor sleep.');
    assert.equal(d.clinicianSummary.consultation, 'agreed');
    assert.match(d.analysisId, /^[a-f\d]{24}$/);

    const view = (await api.staff('GET', `/v1/conversations/${CONV}`)).body;
    assert.equal(view.needsAnalysis, false);
    assert.equal(view.sessionNumber, 2);
    assert.equal(view.analyses[0].delivery, 'delivered');
    assert.equal(view.analyses[0].attempts, 1);
    assert.equal(view.summaries[0].trigger, 'credits_exhausted');
    assert.deepEqual((await api.call('POST', `/v1/conversations/${CONV}/end`)).body, { status: 'nothing_to_analyse' });
    assert.equal(auzy.deliveries.length, 1);
}));

test('delivery to auzy-backend: a failure is kept and retried with backoff by the poll, with the same analysisId', () => withApi({}, async (api, auzy) => {
    auzy.state.failDeliveries = 1;
    await api.send({ text: 'Bye', creditsRemaining: 0, freeConsultationEligible: false });
    await api.scheduler.settled();
    let a = (await api.staff('GET', `/v1/conversations/${CONV}`)).body.analyses[0];
    assert.deepEqual([a.delivery, a.attempts], ['pending', 1]);
    assert.match(a.lastError, /HTTP 500/);
    assert.equal(a.result.diagnostic, null);                     // credits ran out, but not eligible: no pre-diagnostic
    await api.scheduler.pollOnce();
    await api.scheduler.settled();
    assert.equal(auzy.deliveries.length, 0);                    // not before the backoff
    api.advance(3 * MINUTE);
    await api.scheduler.pollOnce();
    await api.scheduler.settled();
    a = (await api.staff('GET', `/v1/conversations/${CONV}`)).body.analyses[0];
    assert.deepEqual([a.delivery, a.attempts], ['delivered', 2]);
    assert.equal(auzy.deliveries[0].analysisId, a.id);
}));

test('idle conversation: analysed by the poll after AI_IDLE_MINUTES, without a pre-diagnostic while credits remain', () => withApi({}, async (api, auzy) => {
    await api.send({ text: 'I have been stressed', creditsRemaining: 7, freeConsultationEligible: true });
    await api.scheduler.pollOnce();
    await api.scheduler.settled();
    assert.equal(api.client.analysisRequests().length, 0);
    api.advance(31 * MINUTE);
    await api.scheduler.pollOnce();
    await api.scheduler.settled();
    assert.equal(auzy.deliveries.length, 1);
    assert.equal(auzy.deliveries[0].trigger, 'idle');
    assert.equal(auzy.deliveries[0].diagnostic, null);
    assert.equal(api.client.analysisRequests()[0].output_config.format.schema.properties.diagnostic, undefined);
    await api.scheduler.pollOnce();                             // the session is closed: nothing more to do
    await api.scheduler.settled();
    assert.equal(api.client.analysisRequests().length, 1);
}));

test('analysis without the stored Cognisys profile fails (it would overwrite it) and is retried later', () => withApi({}, async (api, auzy) => {
    await api.send({ text: 'Long week' });
    auzy.state.snapshotStatus = 500;
    const r = await api.call('POST', `/v1/conversations/${CONV}/end`, { token: STAFF_TOKEN });
    assert.equal(r.status, 502);
    assert.equal(r.body.error, 'analysis_failed');
    assert.equal(api.client.analysisRequests().length, 0);       // nothing was sent to Claude
    assert.equal((await api.staff('GET', `/v1/conversations/${CONV}`)).body.needsAnalysis, true);
    auzy.state.snapshotStatus = 200;
    api.advance(31 * MINUTE);
    await api.scheduler.pollOnce();
    await api.scheduler.settled();
    assert.equal(auzy.deliveries.length, 1);
}));

test('two messages of one conversation at once are handled one after the other', () => withApi({
    client: apiClient({ chat: [() => new Promise((r) => setTimeout(() => r(reply('First answer.')), 60)), reply('Second answer.')] }),
}, async (api) => {
    const [a, b] = await Promise.all([api.send({ text: 'first message' }), api.send({ text: 'second message' })]);
    assert.deepEqual([a.body.reply, b.body.reply], ['First answer.', 'Second answer.']);
    const second = api.client.chatRequests()[1];
    assert.deepEqual(userTexts(second), ['first message', 'second message']);
    assert.match(JSON.stringify(second.messages), /First answer/);
    const view = (await api.staff('GET', `/v1/conversations/${CONV}`)).body;
    assert.equal(view.totalTurns, 2);
    const other = await api.call('POST', '/v1/messages', { body: { conversationId: CONV2, profileId: PROFILE, text: 'other conversation' } });
    assert.equal(other.status, 200);
}));

test('first message of a conversation that started on the old chat carries its last messages over, once', () => withApi({}, async (api) => {
    const history = [
        { role: 'user', content: 'I lost my job last month' }, { role: 'assistant', content: 'That must be hard.' },
        { role: 'system', content: 'ignored' }, { role: 'user', content: '' },
    ];
    await api.send({ text: 'Still looking for work', history });
    const hint = lastHint(api.client.chatRequests()[0]).content;
    assert.match(hint, /earlier conversations/);
    assert.match(hint, /Profile summary: Stored summary/);
    assert.match(hint, /PATIENT: I lost my job last month\nASSISTANT: That must be hard\./);
    assert.doesNotMatch(hint, /ignored/);
    await api.send({ text: 'Any advice?', history: [{ role: 'user', content: 'something else' }] });
    assert.doesNotMatch(lastHint(api.client.chatRequests()[1]).content, /something else|earlier conversations/);
}));

test('greeting: fixed text in the chat language with the persona\'s name; service key only; no Claude call', () => withApi({}, async (api) => {
    const get = (query, token = API_KEY) => api.call('GET', `/v1/welcome${query}`, { token });
    const fr = await get('?language=fr&name=Sami');
    assert.equal(fr.status, 200);
    assert.equal(fr.body.language, 'fr');
    assert.match(fr.body.text, /^Bonjour, je suis Sami, une IA de soutien\. .*l'équipe de soins/);
    assert.deepEqual((await get('')).body, { text: (await get('?language=en')).body.text, language: 'en' });
    assert.match((await get('')).body.text, /^Hello, I'm Auzy's AI support assistant\./);
    assert.match((await get('?language=ar&name=Auzy')).body.text, /^مرحبًا، أنا Auzy،/);
    assert.match((await get('?language=aeb')).body.text, /^Aslema, ena l'assistant virtuel mta3 Auzy/);
    assert.match((await get('?language=de')).body.message, /language must be one of en, fr, ar, aeb/);
    assert.equal((await get('?language=fr&name=a&name=b')).status, 400);
    assert.equal((await get('?language=fr', null)).status, 401);
    assert.equal((await get('?language=fr', STAFF_TOKEN)).status, 401);
    assert.equal(api.client.requests.length, 0);
}));

test('the greeting sent as history with the first message: that reply knows it; no profile lookup, no greeting after', () => withApi({}, async (api, auzy) => {
    const welcome = (await api.call('GET', '/v1/welcome?language=en&name=Auzy')).body.text;
    const history = [{ role: 'assistant', content: welcome }];
    await api.send({ text: 'I feel tired all the time', history });
    await api.send({ text: 'Mostly at work', history });
    const [first, second] = api.client.chatRequests();
    const hint = lastHint(first).content;
    assert.match(hint, /opened with this greeting from you:\nHello, I'm Auzy, an AI support assistant\./);
    assert.doesNotMatch(hint, /earlier conversations/);
    assert.doesNotMatch(lastHint(second).content, /greeting/);
    assert.equal(auzy.calls.filter(([kind]) => kind === 'cognisys').length, 0);
}));

test('a Claude failure returns the fallback text in the patient\'s language, marked as an error', () => withApi({
    client: apiClient({ chat: [new Error('overloaded')] }),
}, async (api) => {
    const r = await api.send({ text: 'Je dors mal ces derniers temps' });
    assert.equal(r.status, 200);
    assert.match(r.body.reply, /Merci de réessayer/);
    assert.equal(r.body.error, 'Error');
    assert.equal(r.body.model, null);
}));

test('costs: measured per 1,000 finished conversations, by kind and model', () => withApi({}, async (api) => {
    await api.send({ text: 'Hello' });
    await api.send({ text: 'Bye', creditsRemaining: 0 });
    await api.scheduler.settled();
    const c = (await api.staff('GET', '/v1/costs?days=7')).body;
    assert.equal(c.days, 7);
    assert.equal(c.conversations, 1);
    assert.equal(c.finishedConversations, 1);
    assert.ok(c.per1000FinishedUsd > 0);
    assert.equal(c.budget.level, 'standard');
    assert.deepEqual(c.budget.targetPer1000Usd, [50, 80]);
    assert.deepEqual(c.byKindAndModel.map((r) => r.kind).sort(), ['chat', 'end_analysis']);
    assert.ok(c.byKindAndModel.every((r) => r.cacheHitShare > 0 && r.calls > 0));
}));

test('demo mode: built-in professionals, analyses kept in the API (delivery none)', () => withApi({
    mode: 'demo', client: apiClient({ chat: [toolCall('find_consultants', {}), reply('Here are three professionals.')] }),
}, async (api) => {
    const r = await api.send({ text: 'Can you show me a psychologist?' });
    assert.deepEqual(r.body.cards.profiles, ['6650000000000000000000a1', '6650000000000000000000a2', '6650000000000000000000a3']);
    const end = await api.call('POST', `/v1/conversations/${CONV}/end`);
    assert.equal(end.body.status, 'done');
    assert.equal(end.body.delivery, 'none');
    assert.equal(end.body.clinicianSummary.consultation, 'agreed');
    assert.equal((await api.call('GET', '/v1/health', { token: null })).body.auzy, 'demo');
}));

test('budget governor: decides once a day from the measured cost, keeps the level in the store', async () => {
    const store = createMemoryStore();
    store.measureAverageCost = async () => ({ avgUsd: 0.1, maxUsd: 0.2, samples: 120 });      // $100 per 1,000: over budget
    const api = await startApi({ mode: 'demo', store });
    try {
        assert.equal(api.ai.budget.name(), 'standard');
        assert.deepEqual(await api.scheduler.governOnce(), { level: 0, avgUsd: 0.1, samples: 120 });
        assert.equal(api.ai.budget.name(), 'economy');
        assert.equal(await api.scheduler.governOnce(), null);                                  // already decided today
        assert.equal((await store.getSetting('budget')).level, 0);
    } finally {
        await api.close();
    }
    const restarted = await startApi({ mode: 'demo', store });
    try {
        await restarted.scheduler.restoreBudgetLevel();
        assert.equal(restarted.ai.budget.name(), 'economy');
    } finally {
        await restarted.close();
    }
});

test('settings: missing or weak keys refuse to start; memory store refused in production', () => {
    const config = loadConfig({});
    const ok = { ANTHROPIC_API_KEY: 'x', AUZY_AI_API_KEY: 'k'.repeat(40), AUZY_AI_STAFF_TOKEN: 's'.repeat(40), MONGODB_URI: 'mongodb://db', AUZY_CALLBACK_URL: 'http://auzy/internal/ai/', AUZY_CALLBACK_SECRET: 'c'.repeat(40), ESCALATION_WEBHOOK_URL: 'http://hook' };
    const check = (env) => checkSettings(loadSettings(env), loadConfig(env));
    assert.deepEqual(check(ok), { errors: [], warnings: [] });
    assert.equal(loadSettings(ok).callbackUrl, 'http://auzy/internal/ai');
    assert.equal(loadSettings(ok).mongoDb, 'auzy_ai');
    const errors = (env) => check({ ...ok, ...env }).errors.join(' | ');
    assert.match(errors({ ANTHROPIC_API_KEY: '' }), /ANTHROPIC_API_KEY is missing/);
    assert.match(errors({ AUZY_AI_API_KEY: 'short' }), /AUZY_AI_API_KEY must be at least 32/);
    assert.match(errors({ AUZY_AI_STAFF_TOKEN: 'k'.repeat(40) }), /must differ/);
    assert.match(errors({ MONGODB_URI: '' }), /MONGODB_URI is missing/);
    assert.match(errors({ STORE: 'memory', NODE_ENV: 'production' }), /refused when NODE_ENV=production/);
    assert.match(errors({ AUZY_CALLBACK_URL: '' }), /AUZY_CALLBACK_URL is missing/);
    assert.match(errors({ AUZY_MODE: 'x' }), /AUZY_MODE must be/);
    assert.equal(errors({ STORE: 'memory', AUZY_MODE: 'demo', MONGODB_URI: '', AUZY_CALLBACK_URL: '', AUZY_CALLBACK_SECRET: '' }), '');
    assert.equal(check({ ...ok, STORE: 'memory', AUZY_MODE: 'demo' }).warnings.length, 2);
    assert.match(checkSettings(loadSettings({ ...ok, ESCALATION_WEBHOOK_URL: '' }), config).warnings.join(' '), /ESCALATION_WEBHOOK_URL/);
});

test('mongo store mapping: summaries, analyses and conversation info come out in the API shape', () => {
    const at = new Date('2026-11-02T10:00:00Z');
    assert.deepEqual(toSummary({ _id: { toString: () => 'abc' }, conversation: { toString: () => CONV }, profile: null, trigger: 'idle', urgent: 0, summary: { a: 1 }, createdAt: at }),
        { id: 'abc', conversationId: CONV, profileId: null, trigger: 'idle', model: null, urgent: false, summary: { a: 1 }, createdAt: at });
    assert.deepEqual(toAnalysis({ _id: 'x1', conversation: CONV, trigger: 'idle', result: { diagnostic: null }, delivery: 'pending', createdAt: at }),
        { id: 'x1', conversationId: CONV, profileId: null, trigger: 'idle', model: null, result: { diagnostic: null }, delivery: 'pending', attempts: 0,
            nextAttemptAt: null, lastError: null, deliveredAt: null, createdAt: at });
    assert.deepEqual(toConversationInfo({ profile: PROFILE, creditsRemaining: 0, freeConsultationEligible: true }),
        { profileId: PROFILE, creditsRemaining: 0, freeConsultationEligible: true, persona: null });
    assert.equal(toConversationInfo(null), null);
});
