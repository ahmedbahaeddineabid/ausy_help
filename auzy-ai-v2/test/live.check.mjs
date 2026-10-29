// Live check of Auzy AI v2 with REAL Claude calls (about 10 cents) and the real auzy-risk service.
// Only MongoDB and auzy-backend's services are stand-ins (realistic professionals and tests, so tool cards work).
//
//   1. python -m uvicorn assistant.risk_server:app --port 8001      (project root)
//   2. $env:ANTHROPIC_API_KEY = "..."; node test/live.check.mjs     (auzy-ai-v2)
//
// Conversation A (English, routine): Haiku turns, caching, tool cards, the risk model's known false alarm
//   (Sonnet second opinion, no alert), closing reply at 0 credits, end-of-conversation analysis with pre-diagnostic.
// Conversation B (Derja, abuse): crisis phrase -> alert + Sonnet + urgent summary, closing at 0 credits,
//   end-of-conversation analysis on Sonnet.
// Adds the cost to ../assistant/data/spend.json (the same ledger as the Python scripts) and stops before
// starting if the worst case could take the total over the budget.

import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/ai.config.js';
import { createRiskClient } from '../src/lib/ai/safety/risk.client.js';
import { createTurnService } from '../src/lib/ai/turn.service.js';
import { createAnalysisService } from '../src/lib/ai/analysis.service.js';
import { createToolbox } from '../src/lib/ai/tools/index.js';
import { fakeStore, recorder } from './helpers.js';
import { demoServices as services } from '../server/demo.catalog.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LEDGER = path.resolve(here, '../../assistant/data/spend.json');
const BUDGET = 3.0;
const WORST_CASE = 0.40;

const spent = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')).usd : 0;
if (spent + WORST_CASE > BUDGET) {
    console.error(`STOP: spent $${spent.toFixed(4)}; worst case $${WORST_CASE} would pass $${BUDGET}`);
    process.exit(1);
}

const config = loadConfig({ ...process.env, RISK_SERVICE_URL: process.env.RISK_SERVICE_URL || 'http://127.0.0.1:8001' });
const client = new Anthropic({ maxRetries: 2 });
const store = fakeStore();
const escalate = recorder();
const notify = recorder();
const applied = [];
const cognisys = {
    getSnapshot: async () => ({ profile: { summary: 'Pending summary', tags: [] }, facts: [], dimensions: [], analyses: [] }),
    apply: async (pid, out) => { applied.push(out); },
};
let ready = false;
for (let i = 0; i < 90 && !ready; i += 1) {                       // wait for auzy-risk to load its model
    try { ready = (await fetch(`${config.riskServiceUrl}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 1000)); }
}
if (!ready) {
    console.error(`STOP: auzy-risk is not reachable at ${config.riskServiceUrl}; nothing was sent to Claude.`);
    process.exit(1);
}
const risk = createRiskClient({ url: config.riskServiceUrl, timeoutMs: 5000 });
const turns = createTurnService({ client, config, risk, store, escalate });
const analysis = createAnalysisService({ client, config, store, cognisys, notify });

const persona = { name: 'Auzy', description: 'Assistant de soutien de la plateforme Auzy', behavior: 'chaleureux, mots simples', rules: ['Keep replies short and kind'] };

const CONVERSATIONS = [
    { id: 'convA', label: 'A (English, routine)', turns: [
        ["Hi, I've been feeling low and tired for a few weeks."],
        ['Mostly work. I barely sleep, I wake up at 3am thinking about emails.'],
        ['Is there a test I could take to understand this better?'],
        ['I had something similar two years ago after my exams. It passed after the summer.'],
        ['Could you show me a professional I could talk to?'],
        ['Okay, thank you.', { creditsRemaining: 0, freeConsultation: true }],
    ] },
    { id: 'convB', label: 'B (Derja, abuse)', turns: [
        ['Aslema, ena ta3bana barcha el ayem hedhi'],
        ['Rajli yadhrabni kol lila w ma3adech najjem'],
        ['Le, ena wa7di tawa fel dar, ama 5ayfa barcha', { creditsRemaining: 0, freeConsultation: true }],
    ] },
    // Budget measurement: a full 10-message routine Derja conversation at the standard level (Sonnet, low effort).
    { id: 'convC', label: 'C (Derja, routine, 10 messages)', turns: [
        ['Aslema, ena ta3ban barcha el ayem hedhi w ma n3arech 3lech'],
        ['El khedma barcha, el patron dima y7ott 3lia, w nrawa7 m3a el 8 mta3 el lil'],
        ['Ma nor9odch mli7, nfi9 m3a el 3 mta3 el lil w nebda nkhammem fel khedma'],
        ['Zeda ma 3adech nokhrej m3a s7abi, dima n9ollhom 3andi khedma'],
        ['El makla normal, ama sa3at nensa nekel 3la 5atr el khedma'],
        ['3andi 3amin saret m3aya 7aja kif hedhi wa9t el bac, w t3addet ba3d el sif'],
        ['Sa3at n7ess rou7i ma nesta7el chay, kol chay nfachel fih'],
        ['Le, ma jetni 7atta fekra kif hedhi. Ama n7eb n7ki m3a 7ad mte5asses'],
        ['Behi, chnowa najjem na3mel tawa bech nor9od chwaya a7sen?'],
        ['Behi, ya3tik essa7a, bech njarreb lyoum', { creditsRemaining: 0, freeConsultation: true }],
    ] },
];
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;   // e.g. --only C

const MIXED_SCRIPT = /[A-Za-z][؀-ۿ]|[؀-ۿ][A-Za-z]/;
const money = (n) => `$${n.toFixed(5)}`;
let rowsSeen = 0;
function newRows() {
    const rows = store.usageRows.slice(rowsSeen);
    rowsSeen = store.usageRows.length;
    return rows;
}

const t0 = Date.now();
for (const convo of CONVERSATIONS) {
    if (only && !convo.label.startsWith(only)) continue;
    console.log(`\n================ conversation ${convo.label}`);
    const toolbox = createToolbox({ services, profileId: `${convo.id}-patient`, role: 'patient' });
    for (const [i, [text, opts = {}]] of convo.turns.entries()) {
        const start = Date.now();
        const r = await turns.handleTurn({ conversationId: convo.id, profileId: `${convo.id}-patient`, assistant: persona, toolbox, userText: text, ...opts });
        const ms = Date.now() - start;
        console.log(`\n[${i + 1}] PATIENT: ${text}${opts.creditsRemaining === 0 ? '   (0 credits left after this)' : ''}`);
        for (const u of newRows()) {
            console.log(`    ${u.kind.padEnd(14)} ${u.model.padEnd(18)} input ${u.input}, cache read ${u.cacheRead}, cache write ${u.cacheWrite}, output ${u.output}, ${money(u.costUsd)}${u.refused ? ' REFUSED' : ''}`);
        }
        const cards = Object.entries(r.cards).filter(([, v]) => v.length).map(([k, v]) => `${k}: ${v.length}`).join(', ');
        console.log(`    -> ${r.model} (${r.effort}) | state ${r.state} | escalated ${r.escalated}${cards ? ` | cards ${cards}` : ''}${r.error ? ` | ERROR ${r.error}` : ''} | ${ms} ms`);
        if (MIXED_SCRIPT.test(r.reply)) console.log('    !! mixed Arabic/Latin letters inside a word');
        console.log(`    CLAUDE: ${r.reply.replace(/\n+/g, '\n            ')}`);
        if (r.emergencyText) console.log(`    [banner] ${r.emergencyText}`);
        if (r.jobs.includes('urgent_summary')) {
            const s = await analysis.urgentSummary(convo.id);
            for (const u of newRows()) console.log(`    ${u.kind.padEnd(14)} ${u.model.padEnd(18)} input ${u.input}, output ${u.output}, ${money(u.costUsd)}`);
            console.log(`    URGENT SUMMARY (${s.urgent ? 'urgent' : 'not urgent'}): ${s.narrative}`);
        }
        if (r.jobs.includes('end_analysis')) {
            const out = await analysis.endAnalysis({ conversationId: convo.id, trigger: 'credits_exhausted', includeDiagnostic: true, freeConsultation: true, assistant: persona });
            for (const u of newRows()) console.log(`    ${u.kind.padEnd(14)} ${u.model.padEnd(18)} input ${u.input}, output ${u.output}, ${money(u.costUsd)}`);
            console.log(`\n    --- end-of-conversation analysis (${out.model})`);
            const c = out.clinicianSummary;
            console.log(`    clinician summary: urgent=${c.urgent} | risk ${JSON.stringify(c.risk_flags)} | consultation ${c.consultation} | screening ${JSON.stringify(c.suggested_screening)}`);
            console.log(`    narrative: ${c.narrative}`);
            const g = out.cognisys;
            console.log(`    cognisys: ${g.facts.length} facts ${JSON.stringify(g.facts.map((f) => [f.key, f.value, f.confidence, f.source]))}`);
            console.log(`              dimensions ${JSON.stringify(g.dimensions.map((d) => [d.dimension, d.score]))}`);
            console.log(`              profile: ${g.profile.summary}`);
            console.log(`    pre-diagnostic (patient sees): ${out.diagnostic.summary}`);
            console.log(`              concerns ${JSON.stringify(out.diagnostic.concerns.map((x) => [x.name, x.severity]))}`);
            console.log(`              recommendation: ${out.diagnostic.recommendation}`);
        }
    }
    const rows = store.usageRows.filter((u) => u.conversationId === convo.id);
    const cost = rows.reduce((a, u) => a + u.costUsd, 0);
    const chat = rows.filter((u) => u.kind === 'chat' || u.kind === 'second_opinion');
    const chatCost = chat.reduce((a, u) => a + u.costUsd, 0);
    console.log(`\n    conversation ${convo.label} total: ${money(cost)} (replies ${money(chatCost)} in ${chat.length} calls, analyses ${money(cost - chatCost)})`);
    // Routine replies after the first (the first one writes the whole cache): the number the budget table estimated.
    const later = chat.slice(1).filter((u) => u.model === config.models.careful);
    if (later.length) console.log(`    average later Sonnet reply call: ${money(later.reduce((a, u) => a + u.costUsd, 0) / later.length)} (budget table assumed $0.00360)`);
}

const total = store.usageRows.reduce((a, u) => a + u.costUsd, 0);
console.log('\n================ summary');
const byKind = {};
for (const u of store.usageRows) {
    const k = `${u.kind} / ${u.model}`;
    byKind[k] = byKind[k] || { calls: 0, usd: 0 };
    byKind[k].calls += 1;
    byKind[k].usd += u.costUsd;
}
for (const [k, v] of Object.entries(byKind)) console.log(`  ${k.padEnd(38)} ${v.calls} calls  ${money(v.usd)}`);
console.log(`  escalation alerts: ${escalate.calls.length} (${escalate.calls.map((c) => c.reason).join('; ')})`);
console.log(`  summary notifications: ${notify.calls.length}`);
console.log(`  total for this check: ${money(total)} (${store.usageRows.length} Claude calls, ${((Date.now() - t0) / 1000).toFixed(0)} s)`);

const rec = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : { usd: 0, requests: 0 };
rec.usd += total;
rec.requests += store.usageRows.length;
writeFileSync(LEDGER, JSON.stringify(rec, null, 1));
console.log(`  total spent so far (all checks): $${rec.usd.toFixed(4)} of $${BUDGET.toFixed(2)}`);
