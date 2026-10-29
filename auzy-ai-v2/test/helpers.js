// Stand-ins for Claude, the database, the risk service and auzy-backend's services. No network, no cost.

import { loadConfig } from '../src/config/ai.config.js';

export const config = loadConfig({ RISK_SERVICE_URL: 'http://risk.test' });
export const HAIKU = config.models.routine;
export const SONNET = config.models.careful;

const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 };
const thinking = { type: 'thinking', thinking: '', signature: 'sig' };

export const reply = (text, risk = 'none') => ({
    stop_reason: 'end_turn', usage, content: [thinking, { type: 'text', text: `${text}\n<risk>${risk}</risk>` }],
});
export const toolCall = (name, input = {}, id = 'tu_1') => ({
    stop_reason: 'tool_use', usage, content: [thinking, { type: 'tool_use', id, name, input }],
});
export const refusal = () => ({ stop_reason: 'refusal', usage, content: [] });
export const cutOff = () => ({ stop_reason: 'max_tokens', usage, content: [{ type: 'text', text: '{"cognisys": {"facts": [' }] });
export const json = (obj) => ({ stop_reason: 'end_turn', usage, content: [{ type: 'text', text: JSON.stringify(obj) }] });

/** Scripted Claude client. Script items: a response, an Error to throw, or (params) => response. */
export function fakeClient(script = []) {
    const requests = [];
    const queue = [...script];
    return {
        requests,
        script: queue,
        messages: {
            async create(params, options) {
                requests.push({ params: structuredClone(params), options });
                const next = queue.length ? queue.shift() : reply('Default reply.');
                if (next instanceof Error) throw next;
                return typeof next === 'function' ? next(params) : next;
            },
        },
        chatRequests: () => requests.filter((r) => !r.params.output_config?.format).map((r) => r.params),
        analysisRequests: () => requests.filter((r) => r.params.output_config?.format).map((r) => r.params),
    };
}

/** In-memory store with the same interface as store.mongo.js (copies on read/write, like a database). */
export function fakeStore() {
    const sessions = new Map();
    const usageRows = [];
    const summaries = [];
    return {
        sessions, usageRows, summaries,
        async loadSession(id) { return sessions.has(String(id)) ? structuredClone(sessions.get(String(id))) : null; },
        async saveSession(s) { sessions.set(String(s.conversationId), structuredClone(s)); },
        async logUsage(rec) { usageRows.push(rec); },
        async saveSummary(rec) { summaries.push(rec); },
    };
}

/** Risk service stand-in: PHRASE -> crisis phrase, MODELRISK -> risk model flag, RISKDOWN -> service unavailable. */
export function fakeRisk() {
    return {
        async assess(text) {
            if (text.includes('RISKDOWN')) return { phrase: null, model: null, unavailable: true };
            return {
                phrase: text.includes('PHRASE') ? { category: 'suicidal', language: 'en', match: 'kill myself' } : null,
                model: { risk: text.includes('MODELRISK'), riskScore: text.includes('MODELRISK') ? 0.87 : 0.01, state: text.includes('MODELRISK') ? 'self_harm' : 'normal' },
                unavailable: false,
            };
        },
    };
}

export const longBio = 'x'.repeat(500);

export function fakeServices() {
    return {
        async findProfiles() {
            return {
                profiles: [
                    { _id: 'p1', firstName: 'Amina', lastName: 'B.', bio: longBio, email: 'amina@example.com', phone: '+216 00 000 000', languages: ['fr', 'ar'], availability: [{ day: 1 }] },
                    { _id: 'p2', firstName: 'Karim', lastName: 'S.', title: 'Psychologue', passwordHash: 'secret' },
                ],
            };
        },
        async listAppointmentsForProfile() { return [{ _id: 'a1', status: 'confirmed', startTime: new Date('2026-11-02T10:00:00Z'), consultant: { firstName: 'Amina', lastName: 'B.' }, notes: 'private' }]; },
        async publicListAgents() { return { items: [{ _id: 't1', name: 'PHQ-9', description: 'Depression screening', questions: Array(9).fill({ text: 'q' }) }] }; },
    };
}

export function recorder() {
    const calls = [];
    const fn = async (payload) => { calls.push(payload); return true; };
    fn.calls = calls;
    return fn;
}

export const silentLog = { warn() {}, error() {}, info() {}, log() {} };

export function userTexts(params) {
    return params.messages.filter((m) => m.role === 'user')
        .flatMap((m) => (Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]))
        .filter((b) => b.type === 'text').map((b) => b.text);
}

export const lastHint = (params) => params.messages[params.messages.length - 1];
