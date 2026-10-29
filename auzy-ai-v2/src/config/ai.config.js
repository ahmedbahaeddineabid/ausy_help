// Auzy AI v2 configuration. Every value can be overridden from the environment; tests pass their own env.

export const HAIKU = 'claude-haiku-5-5';
export const SONNET = 'claude-sonnet-5-5';

// USD per million tokens. Haiku 5.5 rates apply to prompts up to 100K tokens; 5-minute cache writes = 1.25x input.
// Opus 4.8 is listed only so cost reports can compare against the old setup.
export const PRICES = {
    'claude-haiku-5-5': { input: 0.10, output: 0.50, cacheRead: 0.01, cacheWrite: 0.125 },
    'claude-sonnet-5-5': { input: 2.00, output: 10.00, cacheRead: 0.20, cacheWrite: 2.50 },
    'claude-opus-4-8': { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
};

export function loadConfig(env = process.env) {
    const num = (name, fallback) => (env[name] !== undefined && env[name] !== '' ? Number(env[name]) : fallback);
    const routine = env.AI_ROUTINE_MODEL || HAIKU;
    const careful = env.AI_CAREFUL_MODEL || SONNET;
    return {
        models: { routine, careful },
        // Effort per model: routine chat replies think little; risk turns and analyses think more.
        effort: { [routine]: env.AI_ROUTINE_EFFORT || 'low', [careful]: env.AI_CAREFUL_EFFORT || 'medium' },
        maxTokens: {
            [routine]: num('AI_ROUTINE_MAX_TOKENS', 2000),
            [careful]: num('AI_CAREFUL_MAX_TOKENS', 4000),
            analysis: num('AI_ANALYSIS_MAX_TOKENS', 12000),    // thinking + JSON; 3000 cut summaries off in testing
        },
        maxToolRoundtrips: num('AI_MAX_TOOL_ROUNDTRIPS', 5),
        chatTimeoutMs: num('AI_CHAT_TIMEOUT_MS', 60000),
        analysisTimeoutMs: num('AI_ANALYSIS_TIMEOUT_MS', 180000), // analyses can run past the client's 60 s default
        riskServiceUrl: (env.RISK_SERVICE_URL || 'http://auzy-risk:8001').replace(/\/$/, ''),
        riskTimeoutMs: num('RISK_TIMEOUT_MS', 1500),
        idleMinutes: num('AI_IDLE_MINUTES', 30),                 // no new message for this long -> end-of-conversation analysis
        emergencyNumber: env.EMERGENCY_NUMBER || '190',
        summaryLanguage: env.SUMMARY_LANGUAGE || 'French',
        escalationWebhookUrl: env.ESCALATION_WEBHOOK_URL || '',
        summaryWebhookUrl: env.SUMMARY_WEBHOOK_URL || '',
        contextMessages: num('AI_CONTEXT_MESSAGES', 6),          // earlier messages carried into a new session
        // Routine replies written by the careful model (quality levels below) think little, like Haiku's.
        // Risk turns keep the careful model's own effort (medium).
        qualityEffort: env.AI_QUALITY_EFFORT || 'low',
        budget: {
            // Average cost target, per 1,000 conversations (a conversation = one sitting: until credits run out or 30 min idle).
            targetMinPer1000Usd: num('AI_TARGET_MIN_PER_1000_USD', 50),
            targetMaxPer1000Usd: num('AI_TARGET_MAX_PER_1000_USD', 80),
            // Above this, a conversation's routine replies and analysis switch to the routine model.
            // Never applied to safety: an escalated conversation keeps the careful model.
            conversationCeilingUsd: num('AI_CONVERSATION_CEILING_USD', 0.15),
            // Quality levels: 0 economy (routine model for every routine reply), 1 standard (careful model for the
            // languages below), 2 premium (careful model for every routine reply). The governor moves between them.
            qualityLanguages: (env.AI_QUALITY_LANGUAGES || 'ar,aeb').split(',').map((s) => s.trim()).filter(Boolean),
            startLevel: num('AI_START_LEVEL', 1),
            minSamples: num('AI_BUDGET_MIN_SAMPLES', 50),         // finished conversations needed before any change
            windowDays: num('AI_BUDGET_WINDOW_DAYS', 7),
            minDaysBetweenUpgrades: num('AI_BUDGET_UPGRADE_COOLDOWN_DAYS', 3),
        },
        prices: PRICES,
    };
}
