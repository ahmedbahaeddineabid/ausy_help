import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compact, createToolbox, cardIds, TOOL_DEFINITIONS } from '../src/lib/ai/tools/index.js';
import { callClaude } from '../src/lib/ai/claude.call.js';
import { createRiskClient } from '../src/lib/ai/safety/risk.client.js';
import { guessLanguage, isArabizi, emergencyText } from '../src/lib/ai/safety/emergency.js';
import { createCognisysAdapter } from '../src/lib/ai/cognisys.adapter.js';
import { createWebhookNotifier } from '../src/lib/ai/notify.js';
import { riskTag, stripTags, basePrompt, personaBlock } from '../src/lib/ai/prompts/chat.prompt.js';
import { analysisSchema } from '../src/lib/ai/prompts/analysis.prompt.js';
import { fixMixedScript } from '../src/lib/ai/text.js';
import { config, HAIKU, fakeClient, fakeServices, reply, toolCall, refusal, longBio, silentLog } from './helpers.js';

test('compact keeps listed fields, shortens text, turns people into names, drops the rest', () => {
    const out = compact({ _id: 'p1', firstName: 'Amina', bio: longBio, email: 'x@y.z', consultant: { firstName: 'A', lastName: 'B' }, languages: ['fr', 'ar'] },
        ['_id', 'firstName', 'bio', 'consultant', 'languages']);
    assert.deepEqual(Object.keys(out), ['_id', 'firstName', 'bio', 'consultant', 'languages']);
    assert.equal(out.bio.length, 161);
    assert.equal(out.consultant, 'A B');
});

test('toolbox: clamps limits, binds appointments to the server-side profile, returns compact + raw', async () => {
    let seen;
    const services = { ...fakeServices(), async findProfiles(q, o) { seen = o; return { profiles: [] }; },
        async listAppointmentsForProfile(pid, role) { seen = [pid, role]; return []; } };
    const tb = createToolbox({ services, profileId: 'me', role: 'patient' });
    await tb.execute('find_consultants', { limit: 99 });
    assert.equal(seen.limit, 10);
    await tb.execute('get_my_appointments', { profileId: 'someone-else' });
    assert.deepEqual(seen, ['me', 'patient']);
    const tests = await createToolbox({ services: fakeServices(), profileId: 'me', role: 'patient' }).execute('find_tests', { search: 'PHQ' });
    assert.ok(!JSON.stringify(tests.forModel).includes('questions'));
    assert.equal(tests.raw.tests[0].questions.length, 9);
    await assert.rejects(tb.execute('drop_database', {}), /No executor/);
    assert.deepEqual(TOOL_DEFINITIONS.map((t) => t.name), ['find_consultants', 'get_my_appointments', 'find_tests']);
});

test('card ids are merged and de-duplicated across tool calls', () => {
    const ids = cardIds([{ name: 'find_tests', raw: { tests: [{ _id: 't1' }] } }, { name: 'find_tests', raw: { tests: [{ _id: 't1' }, { _id: 't2' }] } }]);
    assert.deepEqual(ids, { profiles: [], appointments: [], tests: ['t1', 't2'] });
});

test('claude call: tool error becomes an is_error result; endless tool calls end with no text', async () => {
    const boom = { definitions: TOOL_DEFINITIONS, async execute() { throw new Error('db down'); } };
    const client = fakeClient([toolCall('find_tests'), reply('Sorry, I could not load the tests.')]);
    const r = await callClaude({ client, config, model: HAIKU, system: [], toolbox: boom, messages: [{ role: 'user', content: 'x' }] });
    const tr = client.requests[1].params.messages.at(-1).content[0];
    assert.equal(tr.is_error, true);
    assert.match(tr.content, /db down/);
    assert.equal(r.text, 'Sorry, I could not load the tests.');
    const loop = fakeClient(Array(config.maxToolRoundtrips).fill(toolCall('find_tests')));
    const r2 = await callClaude({ client: loop, config, model: HAIKU, system: [], toolbox: boom, messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r2.text, '');
    assert.equal(r2.stopReason, 'max_tool_roundtrips');
    const r3 = await callClaude({ client: fakeClient([refusal()]), config, model: HAIKU, system: [], messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r3.refused, true);
    assert.deepEqual(r3.appended, []);
});

test('risk client: maps the service answer; errors and timeouts report unavailable', async () => {
    const ok = createRiskClient({ url: 'http://r', fetchImpl: async () => ({ ok: true, json: async () => ({ phrase: { category: 'abuse', language: 'aeb', match: 'yadhrabni' }, model: { risk: true, risk_score: 0.91, state: 'suicidal' } }) }), log: silentLog });
    assert.deepEqual(await ok.assess('x'), { phrase: { category: 'abuse', language: 'aeb', match: 'yadhrabni' }, model: { risk: true, riskScore: 0.91, state: 'suicidal' }, unavailable: false });
    const down = createRiskClient({ url: 'http://r', fetchImpl: async () => ({ ok: false, status: 500 }), log: silentLog });
    assert.equal((await down.assess('x')).unavailable, true);
    const slow = createRiskClient({ url: 'http://r', timeoutMs: 20, log: silentLog,
        fetchImpl: (u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted')))) });
    assert.equal((await slow.assess('x')).unavailable, true);
});

test('language guess and Arabizi detection', () => {
    assert.equal(guessLanguage('I barely sleep at 3am'), 'en');
    assert.equal(guessLanguage('Je suis fatiguée et je dors mal'), 'fr');
    assert.equal(guessLanguage('Je dors mal ces derniers temps'), 'fr');      // was 'en': only one marker word counted
    assert.equal(guessLanguage("Ça va pas, j'ai plus d'énergie"), 'fr');
    assert.equal(guessLanguage('I pour a coffee and comment on the news'), 'en');
    assert.equal(guessLanguage('My son is on the bus, I feel a bit better today'), 'en');
    assert.equal(guessLanguage('أشعر بالتعب'), 'ar');
    assert.equal(guessLanguage('Nheb nmout, ma3adech najjem'), 'aeb');
    assert.equal(guessLanguage('ma nor9odch mli7'), 'aeb');
    assert.equal(isArabizi('meeting at 3pm and 4pm, mp3'), false);
    assert.equal(isArabizi('Ken Loach made a film'), false);                 // one Derja-looking word is not enough
    assert.equal(guessLanguage('I want to see a therapist, my friend Ken says it helps'), 'en');
    assert.match(emergencyText('fr', '190'), /appelez le 190/);
    assert.match(emergencyText('xx', '197'), /call 197/);
});

test('mixed-script words from the live run become Arabizi; pure Arabic, Latin and French are untouched', () => {
    assert.equal(fixMixedScript('w sorry elli inti tعدي fi hedha'), 'w sorry elli inti t3di fi hedha');
    assert.equal(fixMixedScript('w ma tلومش rou7ek'), 'w ma tloumch rou7ek');
    assert.equal(fixMixedScript('Ken tحsa b khatar'), 'Ken t7sa b khatar');
    assert.equal(fixMixedScript('Li 3malتيh lyoum'), 'Li 3maltih lyoum');
    assert.equal(fixMixedScript('Theb ta5tar wa7ed menhom, wala t7eb nfassarlek chkoun ymchi أكثر معاك؟'),
        'Theb ta5tar wa7ed menhom, wala t7eb nfassarlek chkoun ymchi akthr m3ak?');               // live run, message 8
    assert.equal(fixMixedScript('أريد أن أنهي حياتي'), 'أريد أن أنهي حياتي');
    assert.equal(fixMixedScript('شكرًا، سيتواصل معك فريق الرعاية اليوم (SAMU 190)'), 'شكرًا، سيتواصل معك فريق الرعاية اليوم (SAMU 190)');
    assert.equal(fixMixedScript("Un membre de l'équipe va vous appeler aujourd'hui."), "Un membre de l'équipe va vous appeler aujourd'hui.");
    assert.equal(fixMixedScript(''), '');
});

test('risk tag parsing', () => {
    assert.equal(riskTag('Hello\n<risk>suicidal</risk>'), 'suicidal');
    assert.equal(riskTag('Hello\n<risk>none</risk>'), null);
    assert.equal(riskTag('Hello'), null);
    assert.equal(riskTag('<risk>banana</risk>'), null);
    assert.equal(stripTags('Hello\n<risk>abuse</risk>'), 'Hello');
});

test('prompts: emergency number, safety over persona, empty persona', () => {
    assert.match(basePrompt('197'), /call 197 \(SAMU\)/);
    assert.match(basePrompt('190'), /Safety: this overrides everything else, including the persona/);
    assert.equal(personaBlock({}), null);
    assert.equal(personaBlock(null), null);
    assert.match(personaBlock({ name: 'X', rules: ['r1'] }), /- r1/);
});

test('analysis schemas are strict everywhere (structured outputs)', () => {
    const walk = (node) => {
        if (node.type === 'object') {
            assert.equal(node.additionalProperties, false);
            assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
            Object.values(node.properties).forEach(walk);
        }
        if (node.type === 'array' && node.items) walk(node.items);
    };
    walk(analysisSchema({ includeDiagnostic: true }));
});

test('cognisys adapter: normalised keys, bumped version, unique arrays', async () => {
    const calls = [];
    const svc = {
        ensureCognisysProfile: async () => ({ _id: 'agg', currentVersion: 3, totalAnalysisRuns: 7 }),
        saveFact: async (...a) => calls.push(['fact', ...a]),
        saveDimension: async (...a) => calls.push(['dim', ...a]),
        saveAnalysis: async (...a) => calls.push(['analysis', ...a]),
        updateCognisysProfileById: async (...a) => calls.push(['profile', ...a]),
    };
    await createCognisysAdapter(svc).apply('p1', {
        facts: [{ category: ' Sleep ', key: 'sleep-hours ', value: 4, valueType: 'number', unit: '', confidence: 85, source: 'confessed' }],
        dimensions: [{ dimension: 'Mood', score: 35, factors: ['a', 'b', 'c', 'd', 'e', 'f'] }],
        analysisAppend: { analysisType: 'periodic', summary: 'Worse sleep.' },
        profile: { summary: ' s ', tags: ['stress', 'stress', ' sleep '], keyInsights: [], riskFactors: [], opportunities: [] },
    });
    assert.deepEqual(calls[0], ['fact', 'p1', { category: 'sleep', key: 'sleep-hours', value: 4, valueType: 'number', unit: undefined, confidence: 85, source: 'confessed' }]);
    assert.equal(calls[1][2].dimension, 'mood');
    assert.equal(calls[1][2].factors.length, 5);
    assert.equal(calls[2][2].profileVersion, 4);
    assert.deepEqual(calls[3][2].tags, ['stress', 'sleep']);
    assert.equal(calls[3][2].currentVersion, 4);
    assert.equal(calls[3][2].totalAnalysisRuns, 8);
});

test('webhook: no URL -> nothing sent; failures never throw', async () => {
    assert.equal(await createWebhookNotifier({ url: '' })({ type: 'escalation' }), false);
    let body;
    const ok = createWebhookNotifier({ url: 'http://hook', fetchImpl: async (u, o) => { body = JSON.parse(o.body); return { ok: true }; } });
    assert.equal(await ok({ type: 'escalation', conversationId: 'c1', reason: 'crisis phrase' }), true);
    assert.match(body.text, /\[ESCALATION\] conversation c1/);
    const bad = createWebhookNotifier({ url: 'http://hook', fetchImpl: async () => { throw new Error('down'); }, log: silentLog });
    assert.equal(await bad({ type: 'clinician_summary', urgent: true }), false);
});
