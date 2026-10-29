// Settings of the API server. The engine's own settings (models, budget, risk service, webhooks) stay in
// src/config/ai.config.js; both read the same environment (see .env.example).

const MIN_SECRET = 32;

export function loadSettings(env = process.env) {
    const num = (name, fallback) => (env[name] !== undefined && env[name] !== '' ? Number(env[name]) : fallback);
    return {
        production: env.NODE_ENV === 'production',
        port: num('PORT', 8080),
        host: env.HOST || '0.0.0.0',
        apiKey: env.AUZY_AI_API_KEY || '',              // auzy-backend -> this API (messages, end of conversation)
        staffToken: env.AUZY_AI_STAFF_TOKEN || '',      // staff views (conversation state, summaries, costs, clear escalation)
        anthropicApiKey: env.ANTHROPIC_API_KEY || '',
        store: (env.STORE || 'mongo').toLowerCase(),    // mongo | memory (local tests only)
        mongoUri: env.MONGODB_URI || '',
        mongoDb: env.MONGODB_DB || 'auzy_ai',           // a separate database, never Auzy's own
        auzyMode: (env.AUZY_MODE || 'callback').toLowerCase(),   // callback | demo
        callbackUrl: (env.AUZY_CALLBACK_URL || '').replace(/\/$/, ''),
        callbackSecret: env.AUZY_CALLBACK_SECRET || '',  // this API -> auzy-backend (tools, Cognisys snapshot, analysis delivery)
        callbackTimeoutMs: num('AUZY_CALLBACK_TIMEOUT_MS', 5000),
        maxTextChars: num('AI_MAX_TEXT_CHARS', 8000),
        pollMs: num('AI_POLL_MS', 60000),               // idle conversations and pending deliveries are checked this often
        shutdownGraceMs: num('AI_SHUTDOWN_GRACE_MS', 30000),
    };
}

/** -> { errors: [...] (refuse to start), warnings: [...] } */
export function checkSettings(s, config) {
    const errors = [];
    const warnings = [];
    if (!s.anthropicApiKey) errors.push('ANTHROPIC_API_KEY is missing.');
    if (s.apiKey.length < MIN_SECRET) errors.push(`AUZY_AI_API_KEY must be at least ${MIN_SECRET} characters (generate one: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))").`);
    if (s.staffToken && s.staffToken.length < MIN_SECRET) errors.push(`AUZY_AI_STAFF_TOKEN must be at least ${MIN_SECRET} characters.`);
    if (s.staffToken && s.staffToken === s.apiKey) errors.push('AUZY_AI_STAFF_TOKEN must differ from AUZY_AI_API_KEY.');
    if (!s.staffToken) warnings.push('AUZY_AI_STAFF_TOKEN is not set: the staff endpoints (summaries, costs, conversation state, clear escalation) are disabled.');

    if (!['mongo', 'memory'].includes(s.store)) errors.push(`STORE must be "mongo" or "memory", not "${s.store}".`);
    if (s.store === 'mongo' && !s.mongoUri) errors.push('MONGODB_URI is missing (or set STORE=memory for a local test).');
    if (s.store === 'memory' && s.production) errors.push('STORE=memory is for local tests only and is refused when NODE_ENV=production.');
    if (s.store === 'memory') warnings.push('STORE=memory: sessions, summaries and costs are lost when the process stops (local tests only).');

    if (!['callback', 'demo'].includes(s.auzyMode)) errors.push(`AUZY_MODE must be "callback" or "demo", not "${s.auzyMode}".`);
    if (s.auzyMode === 'callback') {
        if (!s.callbackUrl) errors.push('AUZY_CALLBACK_URL is missing (e.g. http://auzy-backend:5000/internal/ai), or set AUZY_MODE=demo.');
        if (s.callbackSecret.length < MIN_SECRET) errors.push(`AUZY_CALLBACK_SECRET must be at least ${MIN_SECRET} characters.`);
    }
    if (s.auzyMode === 'demo') warnings.push('AUZY_MODE=demo: built-in sample professionals and tests, empty Cognisys profiles; analyses stay in this API.');
    if (s.callbackSecret && (s.callbackSecret === s.apiKey || s.callbackSecret === s.staffToken)) errors.push('AUZY_CALLBACK_SECRET must differ from the other keys.');

    if (!config.escalationWebhookUrl) warnings.push('ESCALATION_WEBHOOK_URL is not set: escalations are only logged and returned with the reply.');
    for (const [name, value] of [['PORT', s.port], ['AI_MAX_TEXT_CHARS', s.maxTextChars], ['AI_POLL_MS', s.pollMs]]) {
        if (!Number.isFinite(value) || value <= 0) errors.push(`${name} must be a positive number.`);
    }
    return { errors, warnings };
}
