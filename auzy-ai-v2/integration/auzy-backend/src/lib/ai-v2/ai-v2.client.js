// AI v2 (the Auzy AI API) inside auzy-backend: who uses it, how to call it, and the check on its callbacks.
//   AI_V2_ENABLED=true                     master switch; anything else keeps everyone on today's chat
//   AI_V2_TEST_PROFILES=<id>,<id>          profiles that use AI v2 ("*" = everyone)
//   AI_V2_URL=http://auzy-ai-api:8080      the API, on the internal network
//   AI_V2_API_KEY=...                      the API's AUZY_AI_API_KEY
//   AI_V2_CALLBACK_SECRET=...              the API's AUZY_CALLBACK_SECRET (protects /internal/ai)
//   AI_V2_TIMEOUT_MS=120000                after this, the message is answered by today's chat instead

import { createHash, timingSafeEqual } from 'crypto';

const env = (name, fallback = '') => process.env[name] || fallback;

export function useAiV2(profileId) {
    if (env('AI_V2_ENABLED') !== 'true' || !profileId) return false;
    const listed = env('AI_V2_TEST_PROFILES').split(',').map((s) => s.trim()).filter(Boolean);
    return listed.includes('*') || listed.includes(String(profileId));
}

async function call(method, path, body, timeoutMs = Number(env('AI_V2_TIMEOUT_MS', '120000'))) {
    const base = env('AI_V2_URL').replace(/\/$/, '');
    if (!base) throw new Error('AI_V2_URL is not set');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(`${base}${path}`, {
            method,
            headers: { Authorization: `Bearer ${env('AI_V2_API_KEY')}`, 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
            signal: ctrl.signal,
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(`Auzy AI API ${method} ${path}: HTTP ${res.status} ${data?.message || data?.error || ''}`.trim());
        return data;
    } finally {
        clearTimeout(timer);
    }
}

/** The greeting that opens an empty conversation -> { text, language }. Fixed text, no Claude call: a short timeout. */
export const getWelcome = ({ language, name }) => call('GET', `/v1/welcome?${new URLSearchParams({ language, name: name || '' })}`, undefined, 5000);

/** One patient turn -> { reply, cards: { profiles, appointments, tests }, escalated, emergencyText, model, error, ... } */
export const sendTurn = (payload) => call('POST', '/v1/messages', payload);

/** Runs the end-of-conversation analysis now; its results arrive through POST /internal/ai/analysis. */
export const endConversation = (conversationId) => call('POST', `/v1/conversations/${conversationId}/end`);

const digest = (s) => createHash('sha256').update(String(s)).digest();

/** Express middleware for /internal/ai: only the Auzy AI API, holding the shared secret, gets through. */
export function requireAiSecret(req, res, next) {
    const secret = env('AI_V2_CALLBACK_SECRET');
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!secret || !token || !timingSafeEqual(digest(token), digest(secret))) return res.status(401).json({ error: 'unauthorized' });
    return next();
}
