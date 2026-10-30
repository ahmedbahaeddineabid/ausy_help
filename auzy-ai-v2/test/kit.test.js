// The Auzy-side kit (integration/auzy-backend) against the running API, end to end over HTTP.
// auzy-backend's own modules (RabbitMQ, Redis, models, services) are replaced by small in-memory stand-ins
// written next to a copy of the kit, at the same relative paths the kit imports in the real repository.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { reply, toolCall, userTexts, lastHint } from './helpers.js';
import { startApi, apiClient, API_KEY, CALLBACK_SECRET, CONV, PROFILE } from './api.helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sandbox = path.join(here, '.kit-sandbox');      // inside the project, so 'express' and 'mongoose' resolve
const OTHER = '6650000000000000000000d9';

const STUBS = {
    'src/config/rabbit.config.js': `
        export const consumers = {}; export const pushed = [];
        export function consumeFromQueue(name, fn) { consumers[name] = fn; }
        export async function pushToQueue(name, payload) { pushed.push([name, payload]); }`,
    'src/config/redis.config.js': `
        export const kv = new Map();
        export async function redisConnect() {}
        export async function setNxEx(key, value) { if (kv.has(key)) return false; kv.set(key, value); return true; }
        export function getRedis() { return { del: async (k) => (kv.delete(k) ? 1 : 0) }; }`,
    'src/model/Message.js': `
        export const db = { messages: [] };
        export const Message = { find(filter) {
            let rows = db.messages.filter((m) => String(m.conversation) === String(filter.conversation));
            const q = { sort() { rows = [...rows].reverse(); return q; }, limit(n) { rows = rows.slice(0, n); return q; }, lean: async () => structuredClone(rows) };
            return q; },
            async exists(filter) { return db.messages.some((m) => String(m.conversation) === String(filter.conversation)) ? { _id: 'm1' } : null; } };`,
    'src/model/Profile.js': `
        export const profiles = new Map();
        export const Profile = { findById(id) { return { select: async () => profiles.get(String(id)) || null }; } };`,
    'src/services/chat.service.js': `
        import { db } from '../model/Message.js';
        export const conversations = new Map(); export const created = [];
        export async function getConversationByIdPopulated(id) { return conversations.get(String(id)) || null; }
        export async function createAssistantMessage(conversation, payload) {
            const m = { conversation, role: 'assistant', ...payload }; db.messages.push(m); created.push(m); return m; }`,
    'src/services/profile.service.js': `
        import { profiles } from '../model/Profile.js';
        export async function findProfiles() { return { profiles: [{ _id: '6650000000000000000000a1', firstName: 'Amina', lastName: 'B.',
            email: 'amina@clinic.tn', phone: '+216 00 000 001', passwordHash: 'secret', specialities: ['anxiété'], availability: [{ day: 1 }] }] }; }
        export async function findProfileById(id) { return profiles.get(String(id)) || null; }`,
    'src/services/appointment.service.js': `
        export const seen = [];
        export async function listAppointmentsForProfile(profileId, role, opts) { seen.push([profileId, role, opts]);
            return [{ _id: '6650000000000000000000e1', status: 'confirmed', startTime: new Date('2026-11-03T10:00:00Z'), notes: 'private note',
                consultant: { _id: '6650000000000000000000a1', firstName: 'Amina', lastName: 'B.', email: 'amina@clinic.tn' } }]; }`,
    'src/services/agent.service.js': `
        export default { async publicListAgents() { return { items: [{ _id: '6650000000000000000000b1', name: 'PHQ-9', description: 'Dépistage',
            questions: Array(9).fill({ text: 'q' }) }] }; } };`,
    'src/services/assistant.service.js': `
        export default { async getGlobalDefaultAssistant() { return { _id: '6650000000000000000000f1', name: 'Auzy', description: 'Soutien',
            behavior: 'chaleureux', rules: ['Short replies'], createdBy: '6650000000000000000000f2' }; } };`,
    'src/services/library.service.js': `
        export const logged = []; export default { async logInteraction(x) { logged.push(x); } };`,
    'src/services/cognisys.service.js': `
        export const calls = [];
        export default {
            async ensureCognisysProfile(pid) { return { _id: 'cp1', profile: pid, summary: 'Stored summary', currentVersion: 2, totalAnalysisRuns: 3 }; },
            async getCognisysProfileByProfileId() { return { _id: 'cp1', summary: 'Stored summary', tags: ['sleep'] }; },
            async getFacts() { return []; }, async getDimensions() { return []; }, async getAnalyses() { return []; },
            async saveFact(pid, f) { calls.push(['fact', pid, f]); }, async saveDimension(pid, d) { calls.push(['dimension', pid, d]); },
            async saveAnalysis(pid, a) { calls.push(['analysis', pid, a]); }, async updateCognisysProfileById(id, set) { calls.push(['profile', id, set]); },
        };`,
    'src/services/diagnostic.service.js': `
        export const diagnostics = [];
        export async function createDiagnostic(d) { const doc = { _id: 'diag' + (diagnostics.length + 1), ...d }; diagnostics.push(doc); return doc; }
        export async function getLatestDiagnosticForProfile(pid) { return diagnostics.filter((d) => String(d.profile) === String(pid)).at(-1) || null; }`,
    'src/factories/notification.factory.js': `
        export const notifications = []; export async function createNotification(n) { notifications.push(n); }`,
    'src/enums/notification.enums.js': `export const NotificationTypes = { DIAGNOSTIC_READY: 'DIAGNOSTIC_READY' };`,
    'src/lib/claude/diagnostic.service.js': `
        export const triggered = []; export async function maybeTriggerDiagnostic(p, c) { triggered.push([p, c]); return null; }`,
};

const load = (rel) => import(pathToFileURL(path.join(sandbox, rel)).href);
let m;              // stand-in modules, for their recorded state
let consume;        // the kit's ai_v2_request consumer
let api;
let auzyServer;
let auzyUrl;

before(async () => {
    rmSync(sandbox, { recursive: true, force: true });
    cpSync(path.join(here, '../integration/auzy-backend'), sandbox, { recursive: true });
    for (const [rel, code] of Object.entries(STUBS)) {
        mkdirSync(path.dirname(path.join(sandbox, rel)), { recursive: true });
        writeFileSync(path.join(sandbox, rel), code);
    }
    m = {
        rabbit: await load('src/config/rabbit.config.js'), redis: await load('src/config/redis.config.js'),
        messages: await load('src/model/Message.js'), profiles: await load('src/model/Profile.js'), chat: await load('src/services/chat.service.js'),
        appointments: await load('src/services/appointment.service.js'), library: await load('src/services/library.service.js'),
        cognisys: await load('src/services/cognisys.service.js'), diagnostics: await load('src/services/diagnostic.service.js'),
        notifications: await load('src/factories/notification.factory.js'), v1: await load('src/lib/claude/diagnostic.service.js'),
        client: await load('src/lib/ai-v2/ai-v2.client.js'),
    };
    await load('src/queues/ai_v2.queue.js');
    consume = m.rabbit.consumers.ai_v2_request;

    // auzy-backend with the kit's two routers, as the README mounts them.
    const app = express();
    app.use('/internal/ai', (await load('src/routes/ai-tools.route.js')).default, (await load('src/routes/ai-webhook.route.js')).default);
    auzyServer = app.listen(0, '127.0.0.1');
    await once(auzyServer, 'listening');
    auzyUrl = `http://127.0.0.1:${auzyServer.address().port}`;

    api = await startApi({
        auzy: { base: `${auzyUrl}/internal/ai`, url: auzyUrl },
        client: apiClient({ chat: [toolCall('find_consultants', {}), toolCall('get_my_appointments', { when: 'upcoming' }, 'tu_2'), reply('Amina could help.'),
            reply('Try to keep a regular bedtime.'), reply('Take care. A short pre-assessment will appear in your account.')] }),
    });
    Object.assign(process.env, {
        AI_V2_ENABLED: 'true', AI_V2_TEST_PROFILES: `${OTHER}, ${PROFILE}`, AI_V2_URL: api.url, AI_V2_API_KEY: API_KEY, AI_V2_CALLBACK_SECRET: CALLBACK_SECRET,
    });
    m.profiles.profiles.set(PROFILE, { _id: PROFILE, role: 'patient', freeConsultationEligible: true });
    m.chat.conversations.set(CONV, { _id: CONV, profile: PROFILE, currentAssistant: null });
    m.messages.db.messages.push(
        { conversation: CONV, role: 'user', content: 'Earlier on the old chat: I sleep badly' },
        { conversation: CONV, role: 'assistant', content: 'That sounds hard.' },
        { conversation: CONV, role: 'system', content: 'Chat language: English' },
        { conversation: CONV, role: 'user', content: 'Can you show me someone to talk to?' },
    );
});

after(async () => {
    await api?.close();
    await new Promise((r) => (auzyServer ? auzyServer.close(r) : r()));
    rmSync(sandbox, { recursive: true, force: true });
});

const say = (content) => m.messages.db.messages.push({ conversation: CONV, role: 'user', content });

test('test accounts only: the switch and the profile list', () => {
    assert.equal(m.client.useAiV2(PROFILE), true);
    assert.equal(m.client.useAiV2('6650000000000000000000d5'), false);
    process.env.AI_V2_ENABLED = 'false';
    assert.equal(m.client.useAiV2(PROFILE), false);
    process.env.AI_V2_ENABLED = 'true';
    process.env.AI_V2_TEST_PROFILES = '*';
    assert.equal(m.client.useAiV2('6650000000000000000000d5'), true);
    process.env.AI_V2_TEST_PROFILES = `${OTHER}, ${PROFILE}`;
});

test('a turn through the kit: reply and cards saved like today, lookups served by auzy-backend without private fields', async () => {
    await consume({ conversation: CONV, creditsRemaining: 4 });
    const saved = m.chat.created.at(-1);
    assert.equal(saved.content, 'Amina could help.');
    assert.deepEqual(saved.profiles, ['6650000000000000000000a1']);
    assert.deepEqual(saved.appointments, ['6650000000000000000000e1']);
    assert.equal(saved.tests, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(saved.metadata)), { ai: { version: 2, model: 'claude-haiku-5-5', escalated: false } });   // as MongoDB stores it
    assert.deepEqual(m.appointments.seen[0], [PROFILE, 'patient', { when: 'upcoming', limit: 10 }]);

    const sent = api.client.chatRequests()[0];
    assert.deepEqual(userTexts(sent), ['Can you show me someone to talk to?']);
    const hint = lastHint(sent).content;
    assert.match(hint, /changed a chat setting: Chat language: English/);
    assert.match(hint, /PATIENT: Earlier on the old chat: I sleep badly/);            // carried over from the old chat
    assert.match(sent.system[1].text, /You speak as: Auzy/);                             // the platform's default persona
    const toModel = JSON.stringify(api.client.requests.map((r) => r.params.messages));
    assert.doesNotMatch(toModel, /amina@clinic\.tn|passwordHash|private note|\+216/);
    assert.equal(m.library.logged.length, 0);                                           // consultant cards: not logged, as today
});

test('a duplicate job finds nothing new; the next message is logged to the master\'s library', async () => {
    const calls = api.client.requests.length;
    await consume({ conversation: CONV, creditsRemaining: 4 });
    assert.equal(api.client.requests.length, calls);
    say('I wake up at 3am every night');
    await consume({ conversation: CONV, creditsRemaining: 3 });
    assert.equal(m.chat.created.at(-1).content, 'Try to keep a regular bedtime.');
    assert.equal(m.library.logged.length, 1);
    assert.equal(m.library.logged[0].patientMessage, 'I wake up at 3am every night');
    assert.equal(m.library.logged[0].masterId, '6650000000000000000000f2');
});

test('0 credits: closing reply, then the analysis is saved in Cognisys and the pre-diagnostic created, once', async () => {
    say('Thanks, I have no credits left');
    await consume({ conversation: CONV, creditsRemaining: 0 });
    assert.match(m.chat.created.at(-1).content, /pre-assessment/);
    await api.scheduler.settled();
    const kinds = m.cognisys.calls.map((c) => c[0]);
    assert.deepEqual(kinds, ['fact', 'dimension', 'analysis', 'profile']);
    assert.equal(m.cognisys.calls[0][1], PROFILE);
    assert.equal(m.diagnostics.diagnostics.length, 1);
    assert.equal(m.diagnostics.diagnostics[0].creditsAtTrigger, 0);
    assert.equal(String(m.diagnostics.diagnostics[0].conversation), CONV);
    assert.deepEqual(m.notifications.notifications, [{ profile: PROFILE, type: 'DIAGNOSTIC_READY', payload: {} }]);
    const view = (await api.staff('GET', `/v1/conversations/${CONV}`)).body;
    assert.equal(view.analyses[0].delivery, 'delivered');
    assert.match(api.client.analysisRequests()[0].messages[0].content, /Stored summary/);   // snapshot read through the kit

    // The API delivers again (e.g. it never saw the answer): ignored, nothing saved twice.
    const again = await fetch(`${auzyUrl}/internal/ai/analysis`, {
        method: 'POST', headers: { Authorization: `Bearer ${CALLBACK_SECRET}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ analysisId: view.analyses[0].id, conversationId: CONV, profileId: PROFILE, ...view.analyses[0].result }),
    });
    assert.deepEqual(await again.json(), { ok: true, duplicate: true });
    assert.equal(m.diagnostics.diagnostics.length, 1);
    assert.equal(m.cognisys.calls.length, 4);
});

test('callbacks refuse a wrong secret and bad ids', async () => {
    const post = (p, body, secret = CALLBACK_SECRET) => fetch(`${auzyUrl}/internal/ai${p}`, {
        method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post('/tools/tests', {}, 'wrong')).status, 401);
    assert.equal((await fetch(`${auzyUrl}/internal/ai/cognisys/${PROFILE}`)).status, 401);
    assert.equal((await post('/tools/appointments', { profileId: 'x' })).status, 400);
    assert.equal((await post('/analysis', { analysisId: 'x', conversationId: CONV, profileId: PROFILE })).status, 400);
    const tests = await (await post('/tools/tests', { search: 'PHQ' })).json();
    assert.deepEqual(tests, { items: [{ _id: '6650000000000000000000b1', name: 'PHQ-9', description: 'Dépistage' }] });
});

test('API unreachable: today\'s chat answers instead, and at 0 credits the old pre-diagnostic still runs', async () => {
    process.env.AI_V2_URL = 'http://127.0.0.1:9';
    const errors = [];
    const original = console.error;
    console.error = (...a) => errors.push(a.join(' '));
    try {
        say('Hello again');
        await consume({ conversation: CONV, creditsRemaining: 0 });
    } finally {
        console.error = original;
        process.env.AI_V2_URL = api.url;
    }
    assert.deepEqual(m.rabbit.pushed.at(-1), ['completion_request', { conversation: CONV }]);
    assert.deepEqual(m.v1.triggered.at(-1), [PROFILE, CONV]);
    assert.match(errors.join('\n'), /today's chat answers instead/);
});

test('opening an empty conversation: the greeting is saved once, in the given language; the first reply knows it', async () => {
    const conv3 = '6650000000000000000000c3';
    const convo = { _id: conv3, profile: PROFILE, currentAssistant: null };
    m.chat.conversations.set(conv3, convo);
    const { sendWelcome } = await load('src/lib/ai-v2/ai-v2.welcome.js');
    const saved = () => m.messages.db.messages.filter((x) => x.conversation === conv3);
    await Promise.all([sendWelcome(convo, 'fr'), sendWelcome(convo, 'fr')]);           // the chat opened twice at once
    assert.equal(saved().length, 1);
    assert.match(saved()[0].content, /^Bonjour, je suis Auzy, une IA de soutien\./);    // the platform's default persona
    assert.deepEqual(saved()[0].metadata, { ai: { version: 2, welcome: true } });
    await sendWelcome(convo, 'en');                                                       // not empty any more
    assert.equal(saved().length, 1);

    m.messages.db.messages.push({ conversation: conv3, role: 'user', content: 'Je dors mal' });
    await consume({ conversation: conv3, creditsRemaining: 9 });
    const hint = lastHint(api.client.chatRequests().at(-1)).content;
    assert.match(hint, /opened with this greeting from you:\nBonjour, je suis Auzy/);
    assert.doesNotMatch(hint, /earlier conversations/);
    assert.equal(saved().at(-1).role, 'assistant');
});

test('opening an empty conversation without the API: it opens empty, and the next opening tries again', async () => {
    const conv4 = '6650000000000000000000c4';
    const convo = { _id: conv4, profile: PROFILE, currentAssistant: null };
    const { sendWelcome } = await load('src/lib/ai-v2/ai-v2.welcome.js');
    process.env.AI_V2_URL = 'http://127.0.0.1:9';
    const errors = [];
    const original = console.error;
    console.error = (...a) => errors.push(a.join(' '));
    try {
        await sendWelcome(convo, 'en');
    } finally {
        console.error = original;
        process.env.AI_V2_URL = api.url;
    }
    assert.equal(m.messages.db.messages.filter((x) => x.conversation === conv4).length, 0);
    assert.match(errors.join('\n'), /no greeting for conversation 6650000000000000000000c4, the chat opens empty/);
    await sendWelcome(convo, 'en');
    assert.match(m.messages.db.messages.find((x) => x.conversation === conv4).content, /^Hello, I'm Auzy, an AI support assistant\./);
});

test('the kit\'s Cognisys adapter is the same file as the engine\'s', () => {
    assert.equal(readFileSync(path.join(here, '../integration/auzy-backend/src/lib/ai-v2/cognisys.adapter.js'), 'utf8'),
        readFileSync(path.join(here, '../src/lib/ai/cognisys.adapter.js'), 'utf8'));
});
