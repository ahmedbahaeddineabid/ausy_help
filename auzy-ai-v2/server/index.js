// Auzy AI API: starts the HTTP server (see README.md, "Run the API").
//   node --env-file=.env server/index.js        (Docker: docker compose up -d)

import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../src/config/ai.config.js';
import { createRiskClient } from '../src/lib/ai/safety/risk.client.js';
import { loadSettings, checkSettings } from './settings.js';
import { createApi } from './api.js';
import { createAuzyClient } from './auzy.client.js';
import { demoAuzy } from './demo.catalog.js';
import { createMemoryStore } from './store/memory.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const settings = loadSettings();
const config = loadConfig();

const { errors, warnings } = checkSettings(settings, config);
for (const w of warnings) console.warn(`[api] WARNING: ${w}`);
if (errors.length) {
    for (const e of errors) console.error(`[api] ${e}`);
    console.error('[api] not started: fix the settings above (see .env.example).');
    process.exit(1);
}

async function pingRisk() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    try {
        return (await fetch(`${config.riskServiceUrl}/health`, { signal: ctrl.signal })).ok;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

let store;
try {
    store = settings.store === 'memory'
        ? createMemoryStore()
        : await (await import('./store/mongo.js')).createMongoStore({ uri: settings.mongoUri, dbName: settings.mongoDb });
} catch (e) {
    console.error(`[api] cannot open the ${settings.store} store: ${e?.message || e}`);
    process.exit(1);
}

const client = new Anthropic({ apiKey: settings.anthropicApiKey, maxRetries: 2 });
const risk = createRiskClient({ url: config.riskServiceUrl, timeoutMs: config.riskTimeoutMs });
const auzy = settings.auzyMode === 'demo'
    ? demoAuzy()
    : createAuzyClient({ baseUrl: settings.callbackUrl, secret: settings.callbackSecret, timeoutMs: settings.callbackTimeoutMs });

const { app, scheduler } = createApi({ settings, config, client, risk, store, auzy, checkRisk: pingRisk, version });

const server = app.listen(settings.port, settings.host, async () => {
    console.log(`[api] Auzy AI API ${version} on ${settings.host}:${settings.port} | store ${store.kind} (${settings.store === 'mongo' ? settings.mongoDb : 'not persisted'}) | auzy ${auzy.mode} | models ${config.models.routine} / ${config.models.careful}`);
    if (!(await pingRisk())) console.warn(`[api] WARNING: the risk service at ${config.riskServiceUrl} is not answering yet; every message goes to the careful model until it does.`);
});
server.requestTimeout = 300000;          // a turn can take a while (careful model, tools, second opinion)
scheduler.start();

let stopping = false;
async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`[api] ${signal}: finishing the work in progress (up to ${settings.shutdownGraceMs / 1000} s)...`);
    let timer;
    const grace = new Promise((r) => { timer = setTimeout(r, settings.shutdownGraceMs); });
    await Promise.race([new Promise((r) => server.close(r)), grace]);
    await scheduler.stop(settings.shutdownGraceMs);
    clearTimeout(timer);
    await store.close().catch(() => {});
    process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
