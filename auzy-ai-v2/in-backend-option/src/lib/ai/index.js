// Builds the AI v2 services from auzy-backend's own modules. Import getAi() wherever the AI is needed.

import claudeClient from '../claude/client.claude.js';
import cognisysSvc from '../../services/cognisys.service.js';
import { loadConfig } from '../../config/ai.config.js';
import { createRiskClient } from './safety/risk.client.js';
import { createTurnService } from './turn.service.js';
import { createAnalysisService } from './analysis.service.js';
import { createCognisysAdapter } from './cognisys.adapter.js';
import { createWebhookNotifier } from './notify.js';
import { createBudgetLevel } from './budget.js';
import { mongoStore } from './store.mongo.js';

let instance = null;
let lockImpl = (conversationId, fn) => fn();

/** The queue layer registers its Redis lock here, so closing a session can't race a new turn. */
export function setConversationLock(fn) {
    lockImpl = fn;
}

export function getAi() {
    if (instance) return instance;
    const config = loadConfig();
    const client = claudeClient.getClient();
    const escalationHook = createWebhookNotifier({ url: config.escalationWebhookUrl });
    const summaryHook = createWebhookNotifier({ url: config.summaryWebhookUrl });

    const escalate = async (alert) => {
        console.warn(`[ai] ESCALATION conversation=${alert.conversationId} reason=${alert.reason}`);
        await escalationHook({ type: 'escalation', ...alert });
        // Optional: also create an in-app notification for the assigned consultant here
        // (needs a new NotificationTypes value, e.g. AI_ESCALATION).
    };

    // Quality level 0/1/2, kept inside the $50-80 per 1,000 band by the governor in ai_session.scheduler.js.
    const budget = createBudgetLevel(config.budget);
    const turns = createTurnService({
        client, config, store: mongoStore, escalate, policy: budget,
        risk: createRiskClient({ url: config.riskServiceUrl, timeoutMs: config.riskTimeoutMs }),
    });
    const analysis = createAnalysisService({
        client, config, store: mongoStore, notify: summaryHook,
        cognisys: createCognisysAdapter(cognisysSvc),
        lock: (conversationId, fn) => lockImpl(conversationId, fn),
    });
    instance = { config, turns, analysis, store: mongoStore, budget };
    return instance;
}
