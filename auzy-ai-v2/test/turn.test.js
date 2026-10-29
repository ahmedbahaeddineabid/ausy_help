import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnService, newSession } from '../src/lib/ai/turn.service.js';
import { createToolbox } from '../src/lib/ai/tools/index.js';
import {
    config, HAIKU, SONNET, fakeClient, fakeStore, fakeRisk, fakeServices, recorder, reply, toolCall, refusal,
    silentLog, lastHint, userTexts,
} from './helpers.js';

const persona = { name: 'Dr. Sana (assistant)', domain: 'anxiety', behavior: 'warm', rules: ['Use simple words'] };

function make(script = []) {
    const client = fakeClient(script);
    const store = fakeStore();
    const escalate = recorder();
    const turns = createTurnService({ client, config, risk: fakeRisk(), store, escalate, log: silentLog });
    const toolbox = createToolbox({ services: fakeServices(), profileId: 'prof1', role: 'patient' });
    const turn = (userText, extra = {}) => turns.handleTurn({ conversationId: 'c1', profileId: 'prof1', assistant: persona, toolbox, userText, ...extra });
    return { client, store, escalate, turns, turn };
}

test('routine turn: Haiku at low effort, cached prompt and history, hint after the message, tags hidden', async () => {
    const { client, escalate, turn } = make();
    const r = await turn('Work has been stressful lately');
    const req = client.chatRequests()[0];
    assert.equal(req.model, HAIKU);
    assert.equal(req.output_config.effort, 'low');
    assert.deepEqual(req.thinking, { type: 'adaptive' });
    assert.deepEqual(req.cache_control, { type: 'ephemeral' });
    assert.equal(req.system.length, 2);                                   // base prompt + persona
    assert.ok(req.system.every((b) => b.cache_control?.type === 'ephemeral'));
    assert.match(req.system[1].text, /Dr\. Sana/);
    assert.equal(req.tools.length, 3);
    assert.equal(lastHint(req).role, 'system');
    assert.match(lastHint(req).content, /no risk signal/);
    assert.equal(r.reply, 'Default reply.');
    assert.equal(r.escalated, false);
    assert.equal(r.emergencyText, null);
    assert.deepEqual(r.jobs, []);
    assert.equal(escalate.calls.length, 0);
});

test('history is append-only: the next turn starts with the stored turn, thinking blocks unchanged', async () => {
    const { client, turn } = make();
    await turn('hello');
    await turn('still here');
    const [first, second] = client.chatRequests();
    const stored = [...first.messages, { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'Default reply.\n<risk>none</risk>' }] }];
    assert.deepEqual(second.messages.slice(0, stored.length), stored);
    assert.deepEqual(second.system, first.system);                        // system prompt identical -> cache stays valid
});

test('crisis phrase: alert before replying, Sonnet answers the same turn, urgent summary job', async () => {
    const { client, escalate, turn } = make();
    const r = await turn('PHRASE I want to kill myself');
    assert.equal(escalate.calls.length, 1);
    assert.match(escalate.calls[0].reason, /crisis phrase/);
    const req = client.chatRequests()[0];
    assert.equal(req.model, SONNET);
    assert.equal(req.output_config.effort, 'medium');
    assert.match(lastHint(req).content, /Follow the Safety section/);
    assert.equal(r.escalated, true);
    assert.match(r.emergencyText, /190/);
    assert.deepEqual(r.jobs, ['urgent_summary']);
});

test('risk model alone: Sonnet answers with an unconfirmed hint, no alert, next turn back on Haiku', async () => {
    const { client, escalate, store, turn } = make();
    const r = await turn('MODELRISK I had something similar two years ago');
    assert.equal(client.chatRequests()[0].model, SONNET);
    assert.match(lastHint(client.chatRequests()[0]).content, /often wrong/);
    assert.equal(r.escalated, false);
    assert.equal(escalate.calls.length, 0);
    assert.match((await store.loadSession('c1')).signals[0].reasons[0], /not confirmed/);
    await turn('ok thanks');
    assert.equal(client.chatRequests()[1].model, HAIKU);
});

test('risk model alone, confirmed by Sonnet: escalation with the reason recorded', async () => {
    const { escalate, turn } = make([reply("I'm worried about you.", 'suicidal')]);
    const r = await turn('MODELRISK quiet message');
    assert.equal(r.escalated, true);
    assert.match(escalate.calls[0].reason, /confirmed by careful model \(suicidal\)/);
});

test('risk service down: Sonnet answers carefully, nobody is alerted', async () => {
    const { client, escalate, turn } = make();
    const r = await turn('RISKDOWN I feel tired');
    assert.equal(client.chatRequests()[0].model, SONNET);
    assert.match(lastHint(client.chatRequests()[0]).content, /safety check unavailable/);
    assert.equal(r.escalated, false);
    assert.equal(escalate.calls.length, 0);
});

test("Haiku's own risk tag: its reply is discarded and Sonnet answers; Sonnet clears it -> no alert", async () => {
    const { client, escalate, store, turn } = make([reply('Haiku draft.', 'suicidal'), reply('Thank you for telling me.')]);
    const r = await turn('Sometimes I feel useless');
    assert.deepEqual(client.chatRequests().map((q) => q.model), [HAIKU, SONNET]);
    assert.match(lastHint(client.chatRequests()[1]).content, /first draft flagged suicidal/);
    assert.equal(r.reply, 'Thank you for telling me.');
    assert.equal(r.escalated, false);
    assert.equal(escalate.calls.length, 0);
    assert.ok(!JSON.stringify((await store.loadSession('c1')).transcript).includes('Haiku draft'));
    await turn('ok');
    assert.equal(client.chatRequests()[2].model, HAIKU);
});

test("Haiku's tag confirmed by Sonnet: escalation sticks, one alert per conversation", async () => {
    const { client, escalate, turn } = make([reply('Haiku draft.', 'suicidal'), reply("I'm worried about you.", 'suicidal')]);
    const r1 = await turn("I'm tired of everything");
    assert.equal(r1.escalated, true);
    assert.match(escalate.calls[0].reason, /routine model flagged suicidal, confirmed/);
    const r2 = await turn('thanks, a bit better');
    const r3 = await turn('ok');
    assert.deepEqual(client.chatRequests().slice(2).map((q) => q.model), [SONNET, SONNET]);
    assert.ok(r2.escalated && r3.escalated);
    assert.equal(escalate.calls.length, 1);
});

test('Haiku declines: Sonnet retries the turn and the conversation escalates', async () => {
    const { client, turn } = make([refusal(), reply("I'm here with you.")]);
    const r = await turn('something hard to say');
    assert.deepEqual(client.chatRequests().map((q) => q.model), [HAIKU, SONNET]);
    assert.equal(r.reply, "I'm here with you.");
    assert.equal(r.escalated, true);
});

test('both models decline: the patient gets the emergency text, and it is stored as the reply', async () => {
    const { store, turn } = make([refusal(), refusal()]);
    const r = await turn('ta3bana barcha w ma3adech najjem');
    assert.equal(r.escalated, true);
    assert.equal(r.reply, r.emergencyText);
    assert.match(r.reply, /Ya3tik essa7a/);                               // Derja guessed from the patient's words
    const t = (await store.loadSession('c1')).transcript;
    assert.equal(t[t.length - 1].role, 'assistant');
});

test('API error: polite fallback, history untouched, an escalation from the same turn is kept', async () => {
    const { store, turn } = make([new Error('network down')]);
    const r = await turn('hello');
    assert.equal(r.error, 'Error');
    assert.equal(r.model, null);
    assert.equal(await store.loadSession('c1'), null);                   // nothing half-written
    const m = make([new Error('network down')]);
    const r2 = await m.turn('PHRASE I want to kill myself');
    assert.equal(r2.escalated, true);
    assert.deepEqual(r2.jobs, ['urgent_summary']);
    const s = await m.store.loadSession('c1');
    assert.equal(s.escalation.active, true);
    assert.equal(s.transcript.length, 0);
});

test('tools: compact results go to Claude, full results build the cards, the reply text is kept', async () => {
    const { client, store, turn } = make([toolCall('find_consultants', { search: 'anxiety', limit: 50 }), reply('Here are two professionals who could help.')]);
    const r = await turn('I would like to talk to someone');
    const second = client.chatRequests()[1];
    const toolResult = second.messages[second.messages.length - 1].content[0];
    assert.equal(toolResult.type, 'tool_result');
    assert.ok(!toolResult.content.includes('amina@example.com') && !toolResult.content.includes('secret'));
    assert.ok(toolResult.content.length < 600);
    assert.deepEqual(r.cards, { profiles: ['p1', 'p2'], appointments: [], tests: [] });
    assert.equal(r.reply, 'Here are two professionals who could help.');  // v1 replaced it with canned text
    const roles = (await store.loadSession('c1')).transcript.map((m) => m.role);
    assert.deepEqual(roles, ['user', 'system', 'assistant', 'user', 'assistant']);
});

test('credits reach 0: closing note with the free consultation, end-of-conversation job', async () => {
    const { client, turn } = make();
    const r = await turn('Okay, thank you', { creditsRemaining: 0, freeConsultation: true });
    assert.match(lastHint(client.chatRequests()[0]).content, /no credits left.*free 15-minute consultation/s);
    assert.deepEqual(r.jobs, ['end_analysis']);
    const m = make();
    await m.turn('PHRASE I want to kill myself');
    const r2 = await m.turn('ok', { creditsRemaining: 0 });
    assert.match(lastHint(m.client.chatRequests()[1]).content, /cannot write again for now/);
    assert.deepEqual(r2.jobs, ['end_analysis']);
});

test('language switch: the note goes into the hint after the patient message, the system prompt does not change', async () => {
    const { client, turn } = make();
    await turn('hello');
    await turn('bonjour', { notes: ['From now on, reply in French.'] });
    const [a, b] = client.chatRequests();
    assert.deepEqual(a.system, b.system);
    assert.match(lastHint(b).content, /changed a chat setting: From now on, reply in French/);
    assert.equal(b.messages[b.messages.length - 2].role, 'user');
});

test('a new session starts with context from earlier conversations, only on its first turn', async () => {
    const { client, store, turn } = make();
    await store.saveSession({ ...newSession('c1', 'prof1'), previousContext: 'Profile summary: work stress, poor sleep.' });
    await turn('hi again');
    await turn('still me');
    assert.match(lastHint(client.chatRequests()[0]).content, /earlier conversations.*work stress/s);
    assert.ok(!lastHint(client.chatRequests()[1]).content.includes('earlier conversations'));
});

test('no persona: only the cached base prompt', async () => {
    const client = fakeClient();
    const turns = createTurnService({ client, config, risk: fakeRisk(), store: fakeStore(), escalate: recorder(), log: silentLog });
    await turns.handleTurn({ conversationId: 'c9', profileId: 'p', assistant: null, toolbox: null, userText: 'hi' });
    assert.equal(client.chatRequests()[0].system.length, 1);
    assert.equal(client.chatRequests()[0].tools, undefined);
});

test('a clinician clears the escalation: later replies go back to Haiku', async () => {
    const { client, turns, turn } = make();
    await turn('PHRASE I want to kill myself');
    assert.equal(await turns.clearEscalation('c1', 'clinician7'), true);
    const r = await turn('I met the psychologist today, it helped');
    assert.equal(client.chatRequests()[1].model, HAIKU);
    assert.equal(r.escalated, false);
});

test('multiple patient messages arrive together as one turn', async () => {
    const { client, turn } = make();
    await turn('first message\n\nsecond message');
    assert.deepEqual(userTexts(client.chatRequests()[0]), ['first message\n\nsecond message']);
});

test('mixed-script Derja is fixed in what the patient sees, while the stored history keeps the original', async () => {
    const { store, turn } = make([reply('Merci barcha, ma tلومش rou7ek.')]);
    const r = await turn('ta3bana barcha w ma nor9odch');
    assert.equal(r.reply, 'Merci barcha, ma tloumch rou7ek.');
    assert.ok(JSON.stringify((await store.loadSession('c1')).transcript).includes('tلومش'));   // append-only history untouched
});

test('closing note asks for the three parts explicitly', async () => {
    const { client, turn } = make();
    await turn('Okay, thank you', { creditsRemaining: 0, freeConsultation: true });
    const hint = lastHint(client.chatRequests()[0]).content;
    assert.match(hint, /\(1\) briefly reflect.*\(2\) tell them that a short pre-assessment and an offer of a free 15-minute consultation.*\(3\) say goodbye/s);
});

test('every Claude call is logged with its cost', async () => {
    const { store, turn } = make([reply('Haiku draft.', 'suicidal'), reply('Thank you.')]);
    await turn('Sometimes I feel useless');
    assert.deepEqual(store.usageRows.map((u) => [u.kind, u.model]), [['chat', HAIKU], ['second_opinion', SONNET]]);
    const expectedHaiku = (100 * 0.10 + 50 * 0.50 + 2000 * 0.01) / 1e6;
    assert.ok(Math.abs(store.usageRows[0].costUsd - expectedHaiku) < 1e-12);
});
