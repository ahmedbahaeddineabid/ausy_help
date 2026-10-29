// Stand-ins for the HTTP tests: a scripted Claude client that also answers the analysis calls, a fake auzy-backend
// (callback endpoints + webhooks) and a running API on a free local port. No network beyond 127.0.0.1, no cost.

import express from 'express';
import { once } from 'node:events';
import { loadConfig } from '../src/config/ai.config.js';
import { loadSettings } from '../server/settings.js';
import { createApi } from '../server/api.js';
import { createAuzyClient } from '../server/auzy.client.js';
import { demoAuzy } from '../server/demo.catalog.js';
import { createMemoryStore } from '../server/store/memory.js';
import { fakeClient, fakeRisk, reply, json, silentLog } from './helpers.js';

export const API_KEY = 'k'.repeat(40);
export const STAFF_TOKEN = 's'.repeat(40);
export const CALLBACK_SECRET = 'c'.repeat(40);

export const CONV = '6650000000000000000000c1';
export const CONV2 = '6650000000000000000000c2';
export const PROFILE = '6650000000000000000000d1';

export const sampleSummary = (over = {}) => ({
    urgent: false, urgency_reason: 'not discussed', risk_flags: [], main_concerns: 'stress au travail',
    symptoms: [{ symptom: 'sommeil réduit', duration: 'quelques semaines', frequency_severity: '4-5 h par nuit' }],
    triggers_stressors: 'travail', sleep: '4-5 h', appetite: 'not discussed', functioning: 'not discussed', history: 'not discussed',
    risk_factors: 'not discussed', protective_factors: 'not discussed', suggested_screening: ['PHQ-9'], consultation: 'agreed',
    patient_language: 'en', narrative: 'Stress au travail.', ...over,
});
export const sampleCognisys = {
    facts: [{ category: 'Sleep', key: 'sleep-hours', value: 4, valueType: 'number', unit: 'hours', confidence: 85, source: 'confessed' }],
    dimensions: [{ dimension: 'Sleep', score: 30, factors: ['4-5 h per night'] }],
    analysisAppend: { analysisType: 'periodic', summary: 'Sleep worsened.' },
    profile: { summary: 'Work stress and poor sleep.', tags: ['stress'], keyInsights: [], riskFactors: [], opportunities: ['open to consultation'] },
};
export const sampleDiagnostic = { summary: 'Signs of stress.', concerns: [{ name: 'Stress', severity: 'moderate', note: 'Work overload.' }], recommendation: 'Book the free consultation.' };

/**
 * Claude stand-in: chat calls follow `chat` (a scripted queue, then a default reply); analysis calls are answered
 * from their schema (end-of-conversation analysis or urgent summary), or by `analysis(params)` when given.
 */
export function apiClient({ chat = [], analysis = null } = {}) {
    const client = fakeClient();
    const queue = [...chat];
    client.queue = queue;
    client.messages.create = async (params, options) => {
        client.requests.push({ params: structuredClone(params), options });
        const props = params.output_config?.format?.schema?.properties;
        if (props) {
            if (analysis) return analysis(params);
            return props.cognisys
                ? json({ cognisys: sampleCognisys, clinicianSummary: sampleSummary(), ...(props.diagnostic ? { diagnostic: sampleDiagnostic } : {}) })
                : json(sampleSummary({ urgent: true, urgency_reason: 'suicidal thoughts', risk_flags: ['suicidal'] }));
        }
        const next = queue.length ? queue.shift() : reply('Default reply.');
        if (next instanceof Error) throw next;
        return typeof next === 'function' ? next(params) : next;
    };
    return client;
}

async function listen(app) {
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { server, url: `http://127.0.0.1:${server.address().port}` };
}

/** Fake auzy-backend: the callback endpoints of integration/ and the two care-team webhooks. */
export async function startAuzy() {
    const calls = [];
    const deliveries = [];
    const hooks = [];
    const state = { failDeliveries: 0, snapshotStatus: 200 };
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.post('/hooks/:kind', (req, res) => { hooks.push({ kind: req.params.kind, body: req.body }); res.json({ ok: true }); });
    app.use('/internal/ai', (req, res, next) => (req.get('authorization') === `Bearer ${CALLBACK_SECRET}` ? next() : res.status(401).json({ error: 'unauthorized' })));
    app.post('/internal/ai/tools/find-consultants', (req, res) => {
        calls.push(['find-consultants', req.body]);
        res.json({ profiles: [{ _id: '6650000000000000000000a1', firstName: 'Amina', lastName: 'B.', title: 'Psychologue' }] });
    });
    app.post('/internal/ai/tools/appointments', (req, res) => {
        calls.push(['appointments', req.body]);
        res.json({ appointments: [{ _id: '6650000000000000000000e1', status: 'confirmed', startTime: '2026-11-03T10:00:00.000Z' }] });
    });
    app.post('/internal/ai/tools/tests', (req, res) => {
        calls.push(['tests', req.body]);
        res.json({ items: [{ _id: '6650000000000000000000b1', name: 'PHQ-9', description: 'Depression screening' }] });
    });
    app.get('/internal/ai/cognisys/:profileId', (req, res) => {
        calls.push(['cognisys', req.params.profileId]);
        if (state.snapshotStatus !== 200) return res.status(state.snapshotStatus).json({ error: 'x' });
        return res.json({ profile: { summary: 'Stored summary', tags: ['sleep'] }, facts: [], dimensions: [], analyses: [] });
    });
    app.post('/internal/ai/analysis', (req, res) => {
        if (state.failDeliveries > 0) {
            state.failDeliveries -= 1;
            return res.status(500).json({ error: 'down' });
        }
        deliveries.push(req.body);
        return res.json({ ok: true });
    });
    const { server, url } = await listen(app);
    return { url, base: `${url}/internal/ai`, calls, deliveries, hooks, state, close: () => new Promise((r) => server.close(r)) };
}

/** A running API with a controllable clock. mode: 'callback' (needs `auzy` from startAuzy) or 'demo'. */
export async function startApi({ client = apiClient(), auzy = null, mode = 'callback', env = {}, store = null } = {}) {
    let clock = Date.parse('2026-11-02T10:00:00.000Z');
    const now = () => new Date(clock);
    const settings = loadSettings({
        AUZY_AI_API_KEY: API_KEY, AUZY_AI_STAFF_TOKEN: STAFF_TOKEN, ANTHROPIC_API_KEY: 'test', STORE: 'memory',
        AUZY_MODE: mode, AUZY_CALLBACK_URL: auzy?.base || '', AUZY_CALLBACK_SECRET: CALLBACK_SECRET, ...env,
    });
    const config = loadConfig({
        RISK_SERVICE_URL: 'http://risk.test',
        ESCALATION_WEBHOOK_URL: auzy ? `${auzy.url}/hooks/escalation` : '',
        SUMMARY_WEBHOOK_URL: auzy ? `${auzy.url}/hooks/summary` : '',
        ...env,
    });
    const memory = store || createMemoryStore({ now });
    const backend = mode === 'demo' ? demoAuzy() : createAuzyClient({ baseUrl: settings.callbackUrl, secret: settings.callbackSecret });
    const api = createApi({ settings, config, client, risk: fakeRisk(), store: memory, auzy: backend, checkRisk: async () => true, log: silentLog, now, version: 'test' });
    const { server, url } = await listen(api.app);

    async function call(method, path, { body, token = API_KEY, raw } = {}) {
        const res = await fetch(`${url}${path}`, {
            method,
            headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined || raw ? { 'Content-Type': 'application/json' } : {}) },
            body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    }

    return {
        ...api, url, client, store: memory, settings, config, call,
        send: (body) => call('POST', '/v1/messages', { body: { conversationId: CONV, profileId: PROFILE, ...body } }),
        staff: (method, path, body) => call(method, path, { body, token: STAFF_TOKEN }),
        advance: (ms) => { clock += ms; },
        now,
        close: async () => { await api.scheduler.stop(2000); await new Promise((r) => server.close(r)); },
    };
}
