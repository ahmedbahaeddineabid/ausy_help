// End-to-end check with real processes and no cost: the API (node server/index.js) on a real MongoDB, the real
// risk service, a stand-in auzy-backend (callbacks + webhooks) and a stand-in for Claude (ANTHROPIC_BASE_URL).
// Restarts the API midway to check that state survives. Creates a throwaway database and drops it at the end.
//   1. python -m uvicorn assistant.risk_server:app --port 8001          (project root)
//   2. MONGODB_URI=mongodb://127.0.0.1:27017/ node test/e2e.local.mjs   (auzy-ai-v2)

import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { startAuzy, sampleCognisys, sampleSummary, sampleDiagnostic, API_KEY, STAFF_TOKEN, CALLBACK_SECRET } from './api.helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MONGO = process.env.MONGODB_URI;
const RISK = process.env.RISK_SERVICE_URL || 'http://127.0.0.1:8001';
if (!MONGO) {
    console.error('Set MONGODB_URI (a throwaway database is created and dropped).');
    process.exit(1);
}
let riskUp = false;
for (let i = 0; i < 90 && !riskUp; i += 1) {                     // the risk model takes a few seconds to load
    try { riskUp = (await fetch(`${RISK}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 1000)); }
}
if (!riskUp) {
    console.error(`The risk service is not answering at ${RISK}.`);
    process.exit(1);
}
const dbName = `auzy_ai_e2e_${randomBytes(4).toString('hex')}`;
const A = '6650000000000000000000a0';          // English, routine, ends at 0 credits
const B = '6650000000000000000000b0';          // Derja, abuse disclosure
const PA = '6650000000000000000000da';
const PB = '6650000000000000000000db';

// ---- stand-in for the Claude Messages API: answers from the request content
const claudeCalls = [];
const usage = { input_tokens: 120, output_tokens: 60, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 };
function answer(req) {
    const message = (content, stop = 'end_turn') => ({ id: `msg_${randomBytes(6).toString('hex')}`, type: 'message', role: 'assistant', model: req.model,
        content, stop_reason: stop, stop_sequence: null, usage });
    const props = req.output_config?.format?.schema?.properties;
    if (props) {
        const out = props.cognisys
            ? { cognisys: sampleCognisys, clinicianSummary: sampleSummary(), ...(props.diagnostic ? { diagnostic: sampleDiagnostic } : {}) }
            : sampleSummary({ urgent: true, urgency_reason: 'violence conjugale', risk_flags: ['abuse'] });
        return message([{ type: 'text', text: JSON.stringify(out) }]);
    }
    const last = req.messages.at(-1);
    if (last.role === 'user' && Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result')) {
        return message([{ type: 'text', text: 'Here are two professionals you could talk to.\n<risk>none</risk>' }]);
    }
    const said = req.messages.filter((m) => m.role === 'user').flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'text').at(-1)?.text || '';
    if (/psychologist/i.test(said)) {
        return message([{ type: 'tool_use', id: 'toolu_e2e', name: 'find_consultants', input: { search: 'sleep' } }], 'tool_use');
    }
    if (/yadhrabni/i.test(said)) return message([{ type: 'text', text: 'Ena m3ak. Inti mouch wa7dek.\n<risk>abuse</risk>' }]);
    return message([{ type: 'text', text: `Thank you for telling me.\n<risk>none</risk>` }]);
}
const claude = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        const params = JSON.parse(body);
        claudeCalls.push({ path: req.url, auth: req.headers.authorization || req.headers['x-api-key'], params });
        res.writeHead(200, { 'Content-Type': 'application/json', 'request-id': 'req_e2e' });
        res.end(JSON.stringify(answer(params)));
    });
});
claude.listen(0, '127.0.0.1');
await once(claude, 'listening');
const claudeUrl = `http://127.0.0.1:${claude.address().port}`;

const auzy = await startAuzy();
const PORT = 8000 + Math.floor(Math.random() * 900) + 50;
const base = `http://127.0.0.1:${PORT}`;
let api = null;
let apiLog = '';

async function startApiProcess(extraEnv = {}) {
    const child = spawn(process.execPath, ['server/index.js'], {
        cwd: root,
        env: {
            PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
            PORT: String(PORT), HOST: '127.0.0.1', ANTHROPIC_API_KEY: 'e2e-stand-in-claude-key', ANTHROPIC_BASE_URL: claudeUrl,
            AUZY_AI_API_KEY: API_KEY, AUZY_AI_STAFF_TOKEN: STAFF_TOKEN, STORE: 'mongo', MONGODB_URI: MONGO, MONGODB_DB: dbName,
            AUZY_MODE: 'callback', AUZY_CALLBACK_URL: auzy.base, AUZY_CALLBACK_SECRET: CALLBACK_SECRET, RISK_SERVICE_URL: RISK,
            ESCALATION_WEBHOOK_URL: `${auzy.url}/hooks/escalation`, SUMMARY_WEBHOOK_URL: `${auzy.url}/hooks/summary`,
            AI_IDLE_MINUTES: '0.05', AI_POLL_MS: '500', ...extraEnv,
        },
    });
    child.stdout.on('data', (d) => { apiLog += d; });
    child.stderr.on('data', (d) => { apiLog += d; });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        try {
            if ((await fetch(`${base}/v1/health`)).status) return child;
        } catch { /* not up yet */ }
        if (child.exitCode !== null) throw new Error(`API exited:\n${apiLog}`);
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`API did not start:\n${apiLog}`);
}
async function stopApiProcess() {
    if (!api) return;
    const exited = once(api, 'exit');
    api.kill();
    await exited;
    api = null;
}

async function call(method, p, body, token = API_KEY) {
    const res = await fetch(`${base}${p}`, {
        method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
}
const send = (conversationId, profileId, text, extra = {}) => call('POST', '/v1/messages', { conversationId, profileId, text, ...extra });
const waitFor = async (what, fn, ms = 15000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (await fn()) return;
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`timed out waiting for ${what}`);
};

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

try {
    api = await startApiProcess();
    await step('health: MongoDB and the risk service are up', async () => {
        const h = (await call('GET', '/v1/health')).body;
        assert.deepEqual([h.ok, h.store.kind, h.riskService.ok, h.auzy, h.budgetLevel], [true, 'mongo', true, 'callback', 'standard']);
    });
    await step('keys are checked', async () => {
        assert.equal((await call('POST', '/v1/messages', { conversationId: A, profileId: PA, text: 'x' }, 'wrong')).status, 401);
        assert.equal((await call('GET', '/v1/summaries', null, API_KEY)).status, 401);
    });
    await step('routine English turn: real risk check, routine model, Claude key and cache settings sent', async () => {
        const r = (await send(A, PA, 'I barely sleep, I wake up at 3am thinking about work', { creditsRemaining: 3 })).body;
        assert.equal(r.model, 'claude-haiku-5-5');
        assert.equal(r.escalated, false);
        assert.notEqual(r.state, 'unknown');                   // the risk service answered
        const req = claudeCalls.at(-1);
        assert.equal(req.path, '/v1/messages');
        assert.match(req.auth, /e2e-stand-in-claude-key$/);              // the SDK sends it as Authorization: Bearer
        assert.deepEqual(req.params.thinking, { type: 'adaptive' });
        assert.equal(req.params.output_config.effort, 'low');
        assert.deepEqual(req.params.cache_control, { type: 'ephemeral' });
    });
    await step('tool call goes to auzy-backend, cards come back', async () => {
        const r = (await send(A, PA, 'Could you show me a psychologist?', { creditsRemaining: 2 })).body;
        assert.deepEqual(r.cards.profiles, ['6650000000000000000000a1']);
        assert.equal(auzy.calls.filter((c) => c[0] === 'find-consultants').length, 1);
    });
    await step('Derja abuse disclosure: crisis phrase from the real risk service -> escalation, banner, alert, urgent summary', async () => {
        const r = (await send(B, PB, 'Rajli yadhrabni kol lila w ma3adech najjem', { creditsRemaining: 5 })).body;
        assert.equal(r.escalated, true);
        assert.equal(r.model, 'claude-sonnet-5-5');
        assert.equal(r.language, 'aeb');
        assert.match(r.emergencyText, /190/);
        assert.deepEqual(r.followUp, ['urgent_summary']);
        await waitFor('urgent summary', async () => (await call('GET', '/v1/summaries?urgent=true', null, STAFF_TOKEN)).body.items.length === 1);
        const alert = auzy.hooks.find((h) => h.kind === 'escalation');
        assert.match(alert.body.reason, /crisis phrase \(abuse/);
    });
    await step('0 credits: closing reply, analysis with the Cognisys snapshot, delivered with the pre-diagnostic', async () => {
        const r = (await send(A, PA, 'Thanks, that helps', { creditsRemaining: 0, freeConsultationEligible: true })).body;
        assert.deepEqual(r.followUp, ['end_analysis']);
        await waitFor('analysis delivery', async () => auzy.deliveries.length === 1);
        const d = auzy.deliveries[0];
        assert.deepEqual([d.conversationId, d.profileId, d.trigger], [A, PA, 'credits_exhausted']);
        assert.deepEqual(d.diagnostic, sampleDiagnostic);
        assert.ok(auzy.calls.some((c) => c[0] === 'cognisys' && c[1] === PA));
        const view = (await call('GET', `/v1/conversations/${A}`, null, STAFF_TOKEN)).body;
        assert.deepEqual([view.needsAnalysis, view.sessionNumber, view.analyses[0].delivery], [false, 2, 'delivered']);
    });

    await stopApiProcess();
    api = await startApiProcess();
    await step('after a restart: escalation kept, idle conversation analysed by the poll, costs from the ledger', async () => {
        const view = (await call('GET', `/v1/conversations/${B}`, null, STAFF_TOKEN)).body;
        assert.equal(view.escalation.active, true);
        await waitFor('idle analysis of B', async () => auzy.deliveries.some((d) => d.conversationId === B));
        const d = auzy.deliveries.find((x) => x.conversationId === B);
        assert.equal(d.trigger, 'idle');
        assert.equal(d.diagnostic, null);
        assert.equal(d.clinicianSummary.urgent, true);           // escalated conversation: always urgent
        const r = (await send(B, PB, 'Ena tawa 3and okhti', { creditsRemaining: 4 })).body;
        assert.deepEqual([r.escalated, r.model], [true, 'claude-sonnet-5-5']);
        const c = (await call('GET', '/v1/costs?days=1', null, STAFF_TOKEN)).body;
        assert.equal(c.finishedConversations, 2);
        assert.ok(c.per1000FinishedUsd > 0);
        assert.ok(c.byKindAndModel.some((x) => x.kind === 'urgent_summary'));
    });
    await step('staff clears the escalation: routine model again', async () => {
        assert.deepEqual((await call('POST', `/v1/conversations/${B}/clear-escalation`, { clearedBy: PA }, STAFF_TOKEN)).body, { cleared: true });
        const r = (await send(B, PB, 'Ya3tik essa7a', { creditsRemaining: 3 })).body;
        assert.equal(r.escalated, false);
    });

    await stopApiProcess();
    api = await startApiProcess({ RISK_SERVICE_URL: 'http://127.0.0.1:9' });
    await step('risk service down: health says so, and the careful model answers every message meanwhile', async () => {
        const h = (await call('GET', '/v1/health')).body;
        assert.deepEqual([h.ok, h.riskService.ok], [true, false]);
        const r = (await send(A, PA, 'Hello again', { creditsRemaining: 5 })).body;
        assert.equal(r.model, 'claude-sonnet-5-5');
        assert.equal(r.escalated, false);
    });
} finally {
    await stopApiProcess();
    await auzy.close();
    claude.close();
    const conn = await mongoose.createConnection(MONGO, { dbName }).asPromise();
    if (dbName.startsWith('auzy_ai_e2e_')) await conn.dropDatabase();
    await conn.close();
}
if (/e2e-stand-in-claude-key|yadhrabni|barely sleep/i.test(apiLog)) {
    failed += 1;
    console.log('FAIL the API log contains a key or patient text');
}
console.log(failed ? `\n${failed} check(s) failed. API log:\n${apiLog}` : `\nEnd-to-end check passed (database ${dbName} created and dropped, ${claudeCalls.length} stand-in Claude calls).`);
process.exit(failed ? 1 : 0);
