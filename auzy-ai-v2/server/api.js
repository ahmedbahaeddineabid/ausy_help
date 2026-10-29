// Wires the engine (src/lib/ai) to the HTTP routes and the scheduler. index.js passes the real Claude client,
// risk service, store and auzy-backend callbacks; the tests pass stand-ins.

import { createTurnService } from '../src/lib/ai/turn.service.js';
import { createAnalysisService } from '../src/lib/ai/analysis.service.js';
import { createWebhookNotifier } from '../src/lib/ai/notify.js';
import { createBudgetLevel } from '../src/lib/ai/budget.js';
import { createLock } from './lock.js';
import { createScheduler } from './scheduler.js';
import { createRoutes } from './routes.js';

/**
 * @param deps.auzy  createAuzyClient(...) or demoAuzy(): { mode, services, cognisys, deliverAnalysis }
 * @returns {{ app, scheduler, ai }}
 */
export function createApi({ settings, config, client, risk, store, auzy, checkRisk, fetchImpl = globalThis.fetch, log = console, now = () => new Date(), version = '' }) {
    const withLock = createLock();
    const escalationHook = createWebhookNotifier({ url: config.escalationWebhookUrl, fetchImpl, log });
    const summaryHook = createWebhookNotifier({ url: config.summaryWebhookUrl, fetchImpl, log });

    const escalate = async (alert) => {
        log.warn?.(`[ai] ESCALATION conversation=${alert.conversationId} reason=${alert.reason}`);
        await escalationHook({ type: 'escalation', ...alert });
    };

    // Quality level 0/1/2, kept inside the $50-80 per 1,000 band by the governor in scheduler.js.
    const budget = createBudgetLevel(config.budget);
    const turns = createTurnService({ client, config, risk, store, escalate, policy: budget, log, now });
    const analysis = createAnalysisService({ client, config, store, cognisys: auzy.cognisys, notify: summaryHook, lock: withLock, log, now });
    const ai = { config, turns, analysis, budget };
    const scheduler = createScheduler({ ai, store, deliver: auzy.deliverAnalysis, settings, log, now });
    const app = createRoutes({ ai, store, scheduler, auzy, settings, withLock, checkRisk, log, now, version });
    return { app, scheduler, ai };
}
